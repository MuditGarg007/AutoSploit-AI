import { Inject, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Producer } from 'kafkajs';
import { EnvService } from '../../../config/env.service.js';
import { EventSchemaService } from '../kafka/event-schema.service.js';
import { KAFKA_PRODUCER } from '../kafka/kafka.providers.js';

// Write end of the event log. The ingest-token guard already validated the token;
// here we validate the frozen { ts, type, data } envelope against the generated
// event JSON Schema (ajv — the enforcement gate, plan decision 2), then produce to
// the Kafka topic keyed by engagement_id (partition key = engagement_id preserves
// per-engagement order, §8.2). Ingest NEVER writes Postgres — the projector
// consumer does (§4.D). Fail-closed: schema violation → 422, broker disabled →
// 503, never a silent drop.
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer | null,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(EventSchemaService) private readonly eventSchema: EventSchemaService,
  ) {}

  async push(engagementId: string, event: unknown): Promise<void> {
    if (!this.producer) {
      throw new ServiceUnavailableException('Ingest disabled (no broker configured)');
    }
    const validation = this.eventSchema.validateEvent(event);
    if (!validation.ok) {
      throw new UnprocessableEntityException(
        `Event failed schema validation: ${validation.errors?.join('; ')}`,
      );
    }
    await this.producer.send({
      topic: this.env.kafkaTopic,
      messages: [{ key: engagementId, value: JSON.stringify(event) }],
    });
  }
}
