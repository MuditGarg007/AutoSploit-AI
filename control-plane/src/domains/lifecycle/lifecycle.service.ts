import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';
import { EnvService } from '../../config/env.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { ReposService } from '../repos/repos.service.js';
import { ENGAGEMENT_QUEUE } from './queue/engagement-queue.js';
import type { EngagementJobData } from './queue/engagement-queue.js';
import { IngestTokenService } from './ingest-token.service.js';
import { EngagementStateMachine } from './state-machine/state-machine.js';
import { engagements } from './lifecycle.schema.js';

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

export interface DispatchInput {
  userId: string;
  repoId: number;
  repoFullName: string;
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
      .values({ userId: input.userId, repoFullName: probe.fullName })
      .returning();
    const engagement = row[0];

    const ingestToken = await this.ingestTokens.mint(engagement.id);
    const job: EngagementJobData = {
      engagementId: engagement.id,
      repoRef: probe.fullName,
      githubToken,
      ingestToken,
      timeoutS: this.env.conductorTimeoutS,
    };

    // Enqueue before flipping to dispatched so a queue failure leaves the row
    // `queued` (retryable), never a phantom dispatched job.
    await this.queue.add('run', job);
    await this.transition(engagement.id, 'dispatched');

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

  async list(userId: string): Promise<Engagement[]> {
    return this.db
      .select()
      .from(engagements)
      .where(eq(engagements.userId, userId))
      .orderBy(desc(engagements.createdAt));
  }
}
