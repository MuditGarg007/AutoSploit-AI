import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { trace } from '@opentelemetry/api';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';
import { EnvService } from '../../config/env.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { ReposService } from '../repos/repos.service.js';
import { ENGAGEMENT_QUEUE } from './queue/engagement-queue.js';
import type { EngagementJobData } from './queue/engagement-queue.js';
import { IngestTokenService } from './ingest-token.service.js';
import { EngagementStateMachine } from './state-machine/state-machine.js';
import { engagements } from './lifecycle.schema.js';
// Slice D's projections (findings count + spend) are joined into the list view so
// the overview tiles/rows show real numbers. C stays a read-only consumer of these
// tables — D's projector remains their sole writer (§5 rule 3); this only SELECTs.
import { findings, cost } from '../telemetry/telemetry.schema.js';
import type { Metrics } from '../../core/observability/metrics.js';

export type EngagementState =
  | 'queued'
  | 'dispatched'
  | 'provisioning'
  | 'deploying'
  | 'attacking'
  | 'completed'
  | 'halted'
  | 'failed'
  | 'tearing_down'
  | 'archived';

export type Engagement = typeof engagements.$inferSelect;

// A list row carries the slice-D rollup alongside the lifecycle columns: the
// overview's Findings/Spend tiles and per-row numbers read these. `findings` is a
// count; `usdMicros` is summed cost in micro-USD (divide by 1e6 for dollars),
// matching the `cost` table's unit so no float rounding happens server-side.
export type EngagementListRow = Engagement & {
  findings: number;
  usdMicros: number;
};

// States the lifecycle treats as terminal for concurrency counting: an
// engagement in any of these is no longer consuming a user's "active" slot
// (docs/component-q-quota.md §7.1). Mirrors the state machine's end states.
const TERMINAL_STATES: EngagementState[] = [
  'completed',
  'halted',
  'failed',
  'tearing_down',
  'archived',
];

export interface DispatchInput {
  userId: string;
  // repoId is the whole contract: probeDeployable resolves the authoritative
  // fullName from it (a client-supplied fullName was never read — removed).
  repoId: number;
  // Optional target port forwarded to the conductor's --k8s path (validated at
  // the controller). Persisted on the row and carried on the job; the worker
  // falls back to CONDUCTOR_DEFAULT_TARGET_PORT when absent.
  targetPort?: number;
}

export interface DispatchResult {
  engagement: Engagement;
  ingestToken: string;
}

// Dispatch half of C. Sole writer of engagements. Every state flip goes through
// the state machine; no other slice touches the table (docs/control-plane.md §5).
// Abort ownership is checked here; the actual halt is signalled to the worker by
// the controller (the worker is the execution arm, §5 rule 2).
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ReposService) private readonly repos: ReposService,
    @Inject(IngestTokenService) private readonly ingestTokens: IngestTokenService,
    @Inject(ENGAGEMENT_QUEUE) private readonly queue: Queue<EngagementJobData>,
    @Inject(EngagementStateMachine) private readonly sm: EngagementStateMachine,
    // Optional so the service is constructible without the @Global metrics
    // provider; under DI it is always present.
    @Optional() @Inject('METRICS') private readonly metrics?: Metrics,
  ) {}

  // Validate ownership + deployable, write the row `queued`, mint the ingest
  // token, decrypt the GitHub token for the job, and enqueue on BullMQ. Quota
  // enforcement lands here in P6 (§5 cross-cutting).
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // B's probe doubles as the ownership check: an id outside the user's own
    // repo list is a 404, not a "not deployable" (docs/control-plane.md §4.B).
    const probe = await this.repos.probeDeployable(input.userId, input.repoId);
    if (!probe.deployable) {
      throw new BadRequestException(
        'Repo is not deployable (no Dockerfile/compose)',
      );
    }

    const githubToken = await this.identity.getGithubToken(input.userId);
    if (!githubToken) {
      throw new UnauthorizedException('No GitHub token linked');
    }

    const row = await this.db
      .insert(engagements)
      .values({
        userId: input.userId,
        repoFullName: probe.fullName,
        targetPort: input.targetPort ?? null,
      })
      .returning();
    const engagement = row[0];

    const ingestToken = await this.ingestTokens.mint(engagement.id);
    const job: EngagementJobData = {
      engagementId: engagement.id,
      repoRef: probe.fullName,
      githubToken,
      ingestToken,
      targetPort: engagement.targetPort ?? undefined,
      timeoutS: this.env.conductorTimeoutS,
      // Carry the dispatch span's W3C context to the worker so the BullMQ hop
      // stays in one trace (§6.2). Absent when no root span is active.
      traceparent: activeTraceparent(),
    };

    // Enqueue before flipping to dispatched so a queue failure leaves the row
    // `queued` (retryable), never a phantom dispatched job.
    await this.queue.add('run', job);
    await this.transition(engagement.id, 'dispatched');

    // Sample the queue depth by status after enqueue (Gauge, §6.1). Fail-open —
    // a metrics/broker read must never fail a successful dispatch.
    try {
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
      );
      for (const [status, n] of Object.entries(counts)) {
        this.metrics?.queueDepth.set({ status }, n);
      }
    } catch {
      // visibility only
    }

    return { engagement, ingestToken };
  }

  // The single write path for engagement state. Reads the current state inside
  // a transaction, guards the flip with the state machine, and throws a 409 on
  // an illegal transition — an out-of-order event cannot corrupt state (§7).
  async transition(
    engagementId: string,
    to: EngagementState,
    reason?: { halt?: string; fail?: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await tx
        .select({ state: engagements.state })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!current[0]) {
        throw new NotFoundException('Engagement not found');
      }
      const from = current[0].state;
      if (!this.sm.canTransition(from, to)) {
        throw new ConflictException(
          `Illegal state transition: ${from} -> ${to}`,
        );
      }
      await tx
        .update(engagements)
        .set({
          state: to,
          ...(reason?.halt ? { haltReason: reason.halt } : {}),
          ...(reason?.fail ? { failReason: reason.fail } : {}),
          updatedAt: new Date(),
        })
        .where(eq(engagements.id, engagementId));
    });
  }

  // Ownership gate for abort (and future GET /:id). 404 if the engagement does
  // not exist OR belongs to another user (ownership, not existence — §4.B).
  async assertOwned(engagementId: string, userId: string): Promise<Engagement> {
    const row = await this.db
      .select()
      .from(engagements)
      .where(and(eq(engagements.id, engagementId), eq(engagements.userId, userId)))
      .limit(1);
    if (!row[0]) throw new NotFoundException('Engagement not found');
    return row[0];
  }

  // Current state, for the worker to observe before flipping (the worker must not
  // race dispatch's queued → dispatched flip).
  async getState(engagementId: string): Promise<EngagementState> {
    const row = await this.db
      .select({ state: engagements.state })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!row[0]) throw new NotFoundException('Engagement not found');
    return row[0].state as EngagementState;
  }

  async list(userId: string): Promise<EngagementListRow[]> {
    // Correlated scalar subqueries, not LEFT JOINs: an engagement has many
    // findings AND many cost rows, so joining both would multiply (cartesian) and
    // double-count the sum. The subqueries stay one-row-per-engagement and are
    // cheap at per-user list scale. COALESCE on the sum so an engagement with no
    // cost rows yet reports 0, not NULL.
    // The correlated refs MUST be table-qualified: inside the subquery both
    // `findings.engagement_id` and the outer `engagements.id` are spelled out, or
    // Postgres resolves the bare `engagement_id`/`id` to the subquery's own table
    // and the predicate becomes `findings.engagement_id = findings.id` — always
    // false, so every rollup returns 0. (Interpolating `${findings.engagementId}`
    // via drizzle's sql template renders it UNqualified, which is exactly that
    // bug; interpolating the table object `${findings}` renders `"findings"`, so
    // qualify by hand.)
    return this.db
      .select({
        id: engagements.id,
        userId: engagements.userId,
        repoFullName: engagements.repoFullName,
        targetPort: engagements.targetPort,
        state: engagements.state,
        haltReason: engagements.haltReason,
        failReason: engagements.failReason,
        createdAt: engagements.createdAt,
        updatedAt: engagements.updatedAt,
        findings: sql<number>`(
          select count(*) from ${findings}
          where ${findings}.engagement_id = ${engagements}.id
        )`.mapWith(Number),
        usdMicros: sql<number>`coalesce((
          select sum(${cost}.usd_micros) from ${cost}
          where ${cost}.engagement_id = ${engagements}.id
        ), 0)`.mapWith(Number),
      })
      .from(engagements)
      .where(eq(engagements.userId, userId))
      .orderBy(desc(engagements.createdAt));
  }

  // --- Read-only queries for the Quota layer (Component Q, P6) ---
  // These are pure SELECTs through C's service API — C stays the sole WRITER of
  // engagement state (§5 rule 1); Q reads owner + active count here, never the table.

  // The engagement's owning user (immutable once the row exists). The quota
  // aggregator caches this so it resolves each engagement's owner once, not per
  // event (docs/component-q-quota.md §6.1). Quota-only today; kept public because
  // ownership is a general C read.
  async ownerOf(engagementId: string): Promise<string | null> {
    const row = await this.db
      .select({ userId: engagements.userId })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    return row[0]?.userId ?? null;
  }

  // Count of the user's non-terminal engagements — the concurrency-cap input
  // (docs/component-q-quota.md §7.1). Non-terminal = state NOT IN the terminal
  // set, matching the state machine's active span (queued..attacking).
  async countActive(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(
        and(
          eq(engagements.userId, userId),
          notInArray(engagements.state, TERMINAL_STATES),
        ),
      );
    return rows.length;
  }
}

// Serialise the current OTel context into a W3C traceparent string
// (`00-<trace-id>-<span-id>-<flags>`), or undefined when no span is active. This
// is the value carried on the BullMQ job and later passed to the conductor, so the
// dispatch→provision→attack→ingest trace stays one trace across the process and
// language boundary (docs/component-h-hardening.md §6.3).
export function activeTraceparent(): string | undefined {
  const remote = trace.getActiveSpan();
  if (!remote) return undefined;
  const ctx = remote.spanContext();
  const flags = (ctx.traceFlags & 0x01 ? '01' : '00') as '00' | '01';
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}
