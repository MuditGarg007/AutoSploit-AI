import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import type { Redis } from 'ioredis';
import { EnvService } from '../../../config/env.service.js';
import { REDIS } from '../../../redis/redis.module.js';
import { KAFKA } from '../kafka/kafka.providers.js';
import { TelemetryConsumerLifecycle } from '../kafka/telemetry-consumer.lifecycle.js';

interface RawEvent {
  ts: string;
  type: string;
  data: unknown;
}

// Consumer group off the Kafka topic (D-a live path). Pushes each engagement's
// events into a short-retention Redis Stream that the SSE gateway tails
// (docs/control-plane.md §8.2 — "SSE bridge → pushes each engagement's events
// into a short-retention Redis Stream, which the gateway tails"). Own offset,
// independent of the projector/audit groups. `fromBeginning: false` so a restart
// only picks up new events — the last-mile is ephemeral by design.
@Injectable()
export class SseBridgeConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SseBridgeConsumer.name);
  private consumer: Consumer | null = null;

  constructor(
    @Inject(KAFKA) private readonly kafka: Kafka | null,
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(TelemetryConsumerLifecycle)
    private readonly lifecycle: TelemetryConsumerLifecycle,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.kafka || !this.redis) return;
    this.consumer = this.kafka.consumer({ groupId: 'autosploit-sse-bridge' });
    this.lifecycle.registerConsumer(this.consumer);
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.env.kafkaTopic, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async (payload) => {
        try {
          await this.handle(payload);
        } catch (err) {
          this.logger.warn(`sse-bridge message failed: ${(err as Error).message}`);
        }
      },
    });
  }

  private async handle({ message }: EachMessagePayload): Promise<void> {
    const raw = message.value?.toString('utf8');
    if (!raw) return;
    let event: RawEvent;
    try {
      event = JSON.parse(raw) as RawEvent;
    } catch {
      return; // not a JSON event — ignore, never crash the group
    }
    const key = message.key?.toString('utf8') ?? '';
    // Redis Stream per engagement, capped ~1000 entries (bounded backlog replay).
    await this.redis!.xadd(
      `events:${key}`,
      'MAXLEN', '~', '1000',
      '*',
      'type', event.type,
      'data', JSON.stringify(event.data ?? {}),
      'ts', event.ts,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // lifecycle disconnects registered consumers.
  }
}