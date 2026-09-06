import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Client as MinioClient } from 'minio';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';
import { EnvService } from '../../config/env.service.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import type { EngagementState } from '../lifecycle/lifecycle.service.js';
import { findings } from '../telemetry/telemetry.schema.js';
import { reports } from './reports.schema.js';
import { OBJECT_STORE } from './object-store.js';

// An engagement's report is available once C has driven it to a terminal outcome
// (docs/control-plane.md §4.E "triggered by C reaching a terminal state"). These
// are the outcome states + the teardown/archive states that follow them; a report
// requested before the outcome is settled is a 409, not an empty report.
const REPORT_READY: ReadonlySet<EngagementState> = new Set<EngagementState>([
  'completed',
  'halted',
  'failed',
  'tearing_down',
  'archived',
]);

export interface ReportArtifact {
  key: string;
  url: string | null; // presigned GET URL; null when the object store is unconfigured
}

export interface ReportFinding {
  sourceId: string;
  severity: string;
  title: string;
  data: unknown;
  observedAt: Date;
}

export interface AssembledReport {
  engagementId: string;
  state: EngagementState;
  assembledAt: Date;
  findings: ReportFinding[];
  artifacts: {
    rendered: ReportArtifact;
    rawLog: ReportArtifact;
    memoryBundle: ReportArtifact;
  };
}

// E · Reports. Assembles the final report from `findings` (read-only over D, the
// §8 seam 3) plus object-store artifacts, and is the SOLE writer of `reports`
// (docs/control-plane.md §4.E, §5). Strictly downstream: reads C's row for
// ownership + terminal-state authorization (as D's SSE does), reads D's findings,
// pulls artifacts from the object store — and never writes back into D's tables
// (the P5 exit gate).
//
// The terminal-transition trigger is realized as a pull: the first GET after the
// engagement goes terminal assembles + persists the row, and later reads serve the
// cached row. Assembling on read (rather than a C → E push) keeps E off C's write
// path and avoids a Lifecycle ⇄ Reports module cycle; assemble is idempotent, so
// concurrent first reads converge on one row.
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(OBJECT_STORE) private readonly store: MinioClient | null,
  ) {}

  // GET /engagements/:id/report. Authorizes ownership (404 for a foreign or
  // missing engagement), refuses a report for an engagement that has not reached
  // a terminal state (409), then assembles.
  async report(engagementId: string, userId: string): Promise<AssembledReport> {
    const engagement = await this.lifecycle.assertOwned(engagementId, userId);
    const state = engagement.state as EngagementState;
    if (!REPORT_READY.has(state)) {
      throw new ConflictException(
        `Report not ready — engagement is ${state}, not a terminal state`,
      );
    }

    const row = await this.assemble(engagementId);
    const rows = await this.readFindings(engagementId);

    return {
      engagementId,
      state,
      assembledAt: row.assembledAt,
      findings: rows,
      artifacts: {
        rendered: await this.artifact(row.renderedKey),
        rawLog: await this.artifact(row.rawLogKey),
        memoryBundle: await this.artifact(row.memoryBundleKey),
      },
    };
  }

  // Idempotent: records the deterministic artifact keys for the engagement and
  // returns the persisted row. Sole writer of `reports`; ON CONFLICT DO NOTHING
  // on the unique engagement_id keeps the first assembly's `assembled_at` stable
  // across re-reads (the keys are deterministic, so a re-assemble is a no-op).
  async assemble(engagementId: string): Promise<typeof reports.$inferSelect> {
    const keys = artifactKeys(engagementId);
    await this.db
      .insert(reports)
      .values({
        engagementId,
        renderedKey: keys.rendered,
        rawLogKey: keys.rawLog,
        memoryBundleKey: keys.memoryBundle,
      })
      .onConflictDoNothing({ target: reports.engagementId });

    const row = await this.db
      .select()
      .from(reports)
      .where(eq(reports.engagementId, engagementId))
      .limit(1);
    return row[0];
  }

  // Read-only over D (§8 seam 3): the report's finding list is D's projection of
  // the log. Severity-first would need a rank map; the log order (observed_at)
  // is the meaningful one for a report timeline.
  private async readFindings(engagementId: string): Promise<ReportFinding[]> {
    const rows = await this.db
      .select({
        sourceId: findings.sourceId,
        severity: findings.severity,
        title: findings.title,
        data: findings.data,
        observedAt: findings.observedAt,
      })
      .from(findings)
      .where(eq(findings.engagementId, engagementId))
      .orderBy(desc(findings.observedAt));
    return rows;
  }

  // Presign a GET for one artifact key. Null key (never assembled) or an
  // unconfigured store yields a null URL; the caller surfaces the key regardless
  // so the client can see which artifact is expected.
  private async artifact(key: string | null): Promise<ReportArtifact> {
    if (!key) return { key: '', url: null };
    return { key, url: await this.presignedUrl(key) };
  }

  // Presigned download URL for an object-store key (§4.E). Returns null when the
  // store is unconfigured. Bytes need not exist yet — presigning only signs a URL;
  // the producer (worker / S3 sink) lands the object under the same key.
  async presignedUrl(key: string): Promise<string | null> {
    if (!this.store) return null;
    try {
      return await this.store.presignedGetObject(
        this.env.s3Bucket,
        key,
        this.env.reportUrlTtlS,
      );
    } catch (err) {
      this.logger.warn(
        `presign failed for ${key}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

// Deterministic per-engagement object keys the report indexes: the rendered
// report, the raw JSONL event log, and the harness memory bundle (§4.E). One
// prefix per engagement so an engagement's artifacts list under `report/<id>/`.
export function artifactKeys(engagementId: string): {
  rendered: string;
  rawLog: string;
  memoryBundle: string;
} {
  const base = `report/${engagementId}`;
  return {
    rendered: `${base}/report.json`,
    rawLog: `${base}/events.jsonl`,
    memoryBundle: `${base}/memory-bundle.tar.gz`,
  };
}
