import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';
import { EnvService } from '../../config/env.service.js';
import { LifecycleService } from '../../domains/lifecycle/lifecycle.service.js';

export interface QuotaSnapshot {
  usdMicros: number;
  findings: number;
  activeEngagements: number;
}

export type QuotaReason = 'spend' | 'findings' | 'concurrency' | 'meter_unavailable';

export interface QuotaDecision {
  ok: boolean;
  reason?: QuotaReason;
  snapshot: QuotaSnapshot;
  limits: { usdMicros: number; findings: number; concurrent: number };
}

export const QUOTA_USD_KEY = (userId: string): string => `quota:usd:user:${userId}`;
export const QUOTA_FINDINGS_KEY = (userId: string): string =>
  `quota:findings:user:${userId}`;

// Read + decision API for the quota gate (docs/component-q-quota.md §7). Injects
// REDIS (the meter written by the aggregator group), EnvService (caps), and
// LifecycleService (owner + active-count reads through C's API). PURE READS — this
// service never writes the meter; QuotaAggregatorConsumer is the sole writer.
//
// Each cap with value 0 (its env default) is DISABLED and never contributes a
// reason, so a fresh deploy with no caps set behaves exactly as pre-Q.
//
// Fail-open (§3.5): the spend/findings reads come from Redis (eventually
// consistent, rebuildable). When the meter is unreachable they yield "unknown →
// under cap" under QUOTA_FAIL_OPEN (default true), with a warn + no throw; when
// QUOTA_FAIL_OPEN=false the same condition is a meter-unavailable 429. The
// concurrency read goes to C's Postgres (strongly consistent) and is NOT wrapped —
// if C's DB is down, dispatch is already failing for other reasons.
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
  ) {}

  // Meter reads. Distinguishes "key missing" from "meter unreachable": a healthy
  // but empty meter (fresh user, cold aggregator) reads 0 — only a REJECTING
  // Redis command yields null ("unknown"), which is what the fail-open / fail-
  // closed decision keys on. Each command is individually caught so one bad read
  // degrades to "unknown" rather than throwing mid-check.
  private async meterSnapshot(
    userId: string,
  ): Promise<{ usdMicros: number | null; findings: number | null }> {
    if (!this.redis) return { usdMicros: null, findings: null };

    let usdMicros: number | null = 0;
    try {
      const raw = await this.redis.get(QUOTA_USD_KEY(userId));
      usdMicros = raw === null ? 0 : Number(raw) || 0;
    } catch (err) {
      this.logger.warn(`quota meter read failed: ${(err as Error).message}`);
      usdMicros = null;
    }

    let findings: number | null = 0;
    try {
      findings = await this.redis.scard(QUOTA_FINDINGS_KEY(userId));
    } catch (err) {
      this.logger.warn(`quota meter read failed: ${(err as Error).message}`);
      findings = null;
    }

    return { usdMicros, findings };
  }

  // The concurrency count is C's Postgres truth, not the Redis projection — it
  // does NOT fail open.
  private async concurrencyCount(userId: string): Promise<number> {
    return this.lifecycle.countActive(userId);
  }

  async snapshot(userId: string): Promise<QuotaSnapshot> {
    const meter = await this.meterSnapshot(userId);
    const activeEngagements = await this.concurrencyCount(userId);
    return {
      // Unknown (null) meter values read as 0 in the snapshot: dispatch-time the
      // interceptor treats unknown as under-cap (fail-open); the snapshot only
      // reports what it can see.
      usdMicros: meter.usdMicros ?? 0,
      findings: meter.findings ?? 0,
      activeEngagements,
    };
  }

  async check(userId: string): Promise<QuotaDecision> {
    const meter = await this.meterSnapshot(userId);
    const activeEngagements = await this.concurrencyCount(userId);
    const limits = {
      usdMicros: this.env.quotaMaxUsdMicros,
      findings: this.env.quotaMaxFindings,
      concurrent: this.env.quotaMaxConcurrent,
    };

    // A meter-unavailable state only matters when an ENABLED Redis-derived cap
    // (spend/findings) depends on it. With fail-closed, that blocks dispatch
    // (reason meter_unavailable); with fail-open it reads as 0 → under cap.
    const meterUnknown =
      meter.usdMicros === null || meter.findings === null;
    const redisCapsEnabled = limits.usdMicros > 0 || limits.findings > 0;
    if (meterUnknown && redisCapsEnabled && !this.env.quotaFailOpen) {
      return {
        ok: false,
        reason: 'meter_unavailable',
        snapshot: {
          usdMicros: meter.usdMicros ?? 0,
          findings: meter.findings ?? 0,
          activeEngagements,
        },
        limits,
      };
    }

    // Disabled caps are 0 and never contribute a reason (§8). Meter-unknown reads
    // as 0 → under the cap when fail-open (or when only the Postgres-backed
    // concurrency cap is set — Redis being down must not block that).
    const usd = meter.usdMicros ?? 0;
    const findings = meter.findings ?? 0;

    let reason: QuotaReason | undefined;
    if (limits.usdMicros > 0 && usd >= limits.usdMicros) reason = 'spend';
    else if (limits.findings > 0 && findings >= limits.findings) reason = 'findings';
    else if (
      limits.concurrent > 0 &&
      activeEngagements >= limits.concurrent
    ) {
      reason = 'concurrency';
    }

    return {
      ok: !reason,
      reason,
      snapshot: { usdMicros: usd, findings, activeEngagements },
      limits,
    };
  }

  // The dispatch gate: throws 429 before any job is enqueued when the caller is
  // at/over a cap. The 429 body carries which cap + the snapshot so a client can
  // render both (docs/component-q-quota.md §7).
  async assertUnderCap(userId: string): Promise<void> {
    const decision = await this.check(userId);
    if (decision.ok) return;
    throw new HttpException(
      {
        error: 'quota_exceeded',
        reason: decision.reason,
        snapshot: decision.snapshot,
        limits: decision.limits,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
