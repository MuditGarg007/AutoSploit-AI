import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { DRIZZLE, type Db } from '../../../db/drizzle.module.js';
import { EnvService } from '../../../config/env.service.js';
import { auditLog } from '../telemetry.schema.js';
import { KAFKA } from '../kafka/kafka.providers.js';
import { TelemetryConsumerLifecycle } from '../kafka/telemetry-consumer.lifecycle.js';

interface RawEvent {
  ts: string;
  type: string;
  data: unknown;
}

// Consumer group off the Kafka topic (D-b). INSERT-only immutable retained trail of
// every tool call (§4.D security record): `tool_call` + `tool_result` events land
// as rows, payload = whole envelope, ts from event.ts. No UPDATE/DELETE path
// anywhere — a tool-call record cannot be rewritten or purged via the API.
@Injectable()
export class AuditConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditConsumer.name);
  private consumer: Consumer | null = null;

  constructor(
    @Inject(KAFKA) private readonly kafka: Kafka | null,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(TelemetryConsumerLifecycle)
    private readonly lifecycle: TelemetryConsumerLifecycle,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.kafka) return;
    this.consumer = this.kafka.consumer({ groupId: 'autosploit-audit' });
    this.lifecycle.registerConsumer(this.consumer);
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.env.kafkaTopic, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async (payload) => {
        try {
          await this.handle(payload);
        } catch (err) {
          this.logger.warn(`audit message failed: ${(err as Error).message}`);
        }
      },
    });
  }

  // Public so a replay consumer (D-b test) can drive the exact production INSERT
  // from a fresh group — the rebuild path is the same code as the live path.
  async handle({ message }: EachMessagePayload): Promise<void> {
    const raw = message.value?.toString('utf8');
    if (!raw) return;
    let event: RawEvent;
    try {
      event = JSON.parse(raw) as RawEvent;
    } catch {
      return;
    }
    if (event.type !== 'tool_call' && event.type !== 'tool_result') return;
    await this.db.insert(auditLog).values({
      engagementId: message.key?.toString('utf8') ?? '',
      eventType: event.type,
      ts: new Date(event.ts),
      payload: event,
    });
  }
}
