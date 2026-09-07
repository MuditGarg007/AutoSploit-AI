import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';
import { EnvService } from '../../config/env.service.js';
import { LifecycleService } from '../../domains/lifecycle/lifecycle.service.js';
import { KAFKA } from '../../domains/telemetry/kafka/kafka.providers.js';
import { TelemetryConsumerLifecycle } from '../../domains/telemetry/kafka/telemetry-consumer.lifecycle.js';
import {
  QUOTA_USD_KEY,
  QUOTA_FINDINGS_KEY,
} from './quota.service.js';

// Redis meter keys owned by the aggregator (docs/component-q-quota.md §5). The
// per-engagement hashes exist only to make the per-user counter idempotent (store
// the max, fold the forward delta); dispatch reads the per-user integers O(1).
const ENG_USD_KEY = 'quota:eng-usd';
const ENG_TOKENS_KEY = 'quota:eng-tokens';
const OWNER_KEY = (engagementId: string): string => `quota:owner:${engagementId}`;

interface RawEvent {
  ts: string;
  type: string;
  data: {
    usd?: number;
    tokens?: number;
    id?: string;
    [k: string]: unknown;
  };
}

// The quota aggregator consumer group (docs/component-q-quota.md §6). One more
// kafkajs consumer group off D's topic — same skeleton as the projector / audit /
// sse-bridge groups — writing the Redis meter that QuotaService reads. Own offset,
// fromBeginning: true so a cold start rebuilds the meter from the retained topic.
// Q is a NEW CONSUMER GROUP, never a second writer of cost/findings Postgres rows.
//
// Replay-safe by construction (§3.2): cost events carry CUMULATIVE running totals
// (harness.md §7), so the aggregator stores the monotonic max per engagement and
// folds only the forward delta into the per-user counter. A topic replay re-
// delivers old cost events → delta 0 → meter unchanged. Findings dedup on the
// ledger handle in a Redis SET → re-SADD of an existing member is a no-op, so
// SCARD = distinct-findings count is stable across replays.
@Injectable()
export class QuotaAggregatorConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(QuotaAggregatorConsumer.name);
  private consumer: Consumer | null = null;
  // engagementId → owning userId, resolved once (ownership is immutable). Populated
  // on a cache miss from Redis (quota:owner:<id>) then C's LifecycleService.ownerOf.
  private readonly ownerCache = new Map<string, string>();

  constructor(
    @Inject(KAFKA) private readonly kafka: Kafka | null,
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(TelemetryConsumerLifecycle)
    private readonly lifecycle: TelemetryConsumerLifecycle,
    @Inject(LifecycleService) private readonly lifecycleService: LifecycleService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Null-guarded on KAFKA/REDIS exactly like SseBridgeConsumer: no broker or no
    // Redis → the meter just stays empty, and the fail-open dispatch path (§3.5)
    // treats an empty meter as under-cap. Never crashes boot.
    if (!this.kafka || !this.redis) return;
    this.consumer = this.kafka.consumer({ groupId: 'autosploit-quota-aggregator' });
    this.lifecycle.registerConsumer(this.consumer);
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.env.kafkaTopic,
      fromBeginning: true,
    });
    await this.consumer.run({
      eachMessage: async (payload) => {
        try {
          await this.handle(payload);
        } catch (err) {
          // A bad message never crashes the group.
          this.logger.warn(
            `quota-aggregator message failed: ${(err as Error).message}`,
          );
        }
      },
    });
    this.logger.log('quota-aggregator consumer started (fromBeginning)');
  }

  // Public so a replay test can drive the exact production meter write from a
  // fresh group — the rebuild path is the same code as the live path.
  async handle({ message }: EachMessagePayload): Promise<void> {
    const engagementId = message.key?.toString('utf8') ?? '';
    const raw = message.value?.toString('utf8');
    if (!engagementId || !raw) return;
    let event: RawEvent;
    try {
      event = JSON.parse(raw) as RawEvent;
    } catch {
      return; // not JSON — ignore, never throw
    }

    const userId = await this.ownerOf(engagementId);
    if (!userId) return; // unknown engagement (shouldn't happen post-dispatch) → skip

    if (event.type === 'cost') {
      const newUsd = Math.round((event.data.usd ?? 0) * 1e6);
      const newTokens = event.data.tokens ?? 0;
      await this.foldMax(ENG_USD_KEY, engagementId, newUsd, QUOTA_USD_KEY(userId));
      await this.foldMax(
        ENG_TOKENS_KEY,
        engagementId,
        newTokens,
        `quota:tokens:user:${userId}`,
      );
    } else if (event.type === 'finding' && event.data?.id) {
      // SET dedups on the ledger handle → replay-idempotent; SCARD = count.
      await this.redis!.sadd(
        QUOTA_FINDINGS_KEY(userId),
        `${engagementId}:${event.data.id}`,
      );
    }
  }

  // Store the running-total max for the engagement and fold only the forward delta
  // into the per-user counter (§6.1). Read-modify-write is safe within one
  // aggregator instance because a Kafka consumer processes a partition serially and
  // all events for one engagement share a partition (key = engagement_id).
  private async foldMax(
    engKey: string,
    engagementId: string,
    newValue: number,
    userKey: string,
  ): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    const prev = Number((await redis.hget(engKey, engagementId)) ?? 0) || 0;
    if (newValue > prev) {
      await redis.hset(engKey, engagementId, newValue);
      await redis.incrby(userKey, newValue - prev);
    }
  }

  // Resolve an engagement's owning user once: in-memory Map → Redis quota:owner:<id>
  // → C's ownerOf on a miss, then populate both. Ownership never changes, so the
  // in-process cache is never invalidated; the Redis copy survives a restart.
  private async ownerOf(engagementId: string): Promise<string | null> {
    const cached = this.ownerCache.get(engagementId);
    if (cached) return cached;
    const redis = this.redis;
    if (!redis) return null;
    const stored = await redis.get(OWNER_KEY(engagementId));
    if (stored) {
      this.ownerCache.set(engagementId, stored);
      return stored;
    }
    const userId = await this.lifecycleService.ownerOf(engagementId);
    if (!userId) return null;
    this.ownerCache.set(engagementId, userId);
    // Best-effort persistence of the resolved owner across restarts.
    await redis.set(OWNER_KEY(engagementId), userId).catch(() => undefined);
    return userId;
  }
}
