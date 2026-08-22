import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Admin, Producer } from 'kafkajs';
import { EnvService } from '../../../config/env.service.js';
import { KAFKA, KAFKA_PRODUCER, KAFKA_ADMIN } from './kafka.providers.js';

// Connects the producer and creates the events topic at bootstrap (when a broker
// is configured). Topic = kafkaTopic, `kafkaPartitions` partitions, key =
// engagement_id → per-engagement ordering is preserved across consumers. A broker
// down at boot is log-only here — produce failures surface as 503 at ingest, not
// as a boot failure (fail-fast-but-bootable pattern).
@Injectable()
export class KafkaBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(KafkaBootstrap.name);

  constructor(
    @Inject(KAFKA) private readonly kafka: import('kafkajs').Kafka | null,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer | null,
    @Inject(KAFKA_ADMIN) private readonly admin: Admin | null,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.producer || !this.admin) return;
    try {
      await this.admin.connect();
      await this.admin.createTopics({
        topics: [
          {
            topic: this.env.kafkaTopic,
            numPartitions: this.env.kafkaPartitions,
            replicationFactor: 1,
          },
        ],
      });
      await this.admin.disconnect();
      await this.producer.connect();
      this.logger.log(`Kafka producer connected (topic ${this.env.kafkaTopic})`);
    } catch (err) {
      this.logger.warn(`Kafka bootstrap skipped: ${(err as Error).message}`);
    }
  }
}
