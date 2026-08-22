import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Consumer, Producer } from 'kafkajs';
import { KAFKA_PRODUCER, KAFKA_ADMIN } from './kafka.providers.js';

// Owns the D-slice Kafka resource lifecycle: closes the producer, admin, and every
// consumer group on shutdown (mirror of EngagementWorkerLifecycle in
// lifecycle.module.ts and DrizzlePoolShutdown). The Redis client is owned by
// RedisModule (disconnect() on shutdown), so it is NOT closed here.
@Injectable()
export class TelemetryConsumerLifecycle implements OnApplicationShutdown {
  private readonly consumers: Consumer[] = [];

  constructor(
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer | null,
    @Inject(KAFKA_ADMIN)
    private readonly admin: ReturnType<import('kafkajs').Kafka['admin']> | null,
  ) {}

  registerConsumer(consumer: Consumer): void {
    this.consumers.push(consumer);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.consumers.map((c) => c.disconnect().catch(() => undefined)),
    );
    await this.admin?.disconnect().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
  }
}
