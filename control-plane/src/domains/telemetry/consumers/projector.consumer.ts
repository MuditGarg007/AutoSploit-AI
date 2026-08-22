import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { DRIZZLE, type Db } from '../../../db/drizzle.module.js';
import { EnvService } from '../../../config/env.service.js';
import { findings, cost } from '../telemetry.schema.js';
import { KAFKA } from '../kafka/kafka.providers.js';
import { TelemetryConsumerLifecycle } from '../kafka/telemetry-consumer.lifecycle.js';

interface RawEvent {
  ts: string;
  type: string;
  data: {
    id?: string;
    severity?: string;
    title?: string;
    tokens?: number;
    usd?: number;
    [k: string]: unknown;
  };
}

// Consumer group off the Kafka topic (D-b). Projects `finding` / `cost` events
// into the Postgres tables — these tables are a PROJECTION of the log, rebuildable
// by replay (docs/control-plane.md §8.2 event sourcing). Sole writer of findings /
// cost. Never writes engagement state (§5 rule 3).
//
// Idempotency: `finding` upserts by (engagement_id, source_id) where source_id is
// the finding event's data.id (the ledger handle F-001), NOT the row pk — a topic
// replay rebuilds the table exactly without truncate. `cost` appends a row per
// event (a replay doubles rows — acceptable for projections, and the D-b replay
// proof truncates first).
@Injectable()
export class ProjectorConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProjectorConsumer.name);
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
    this.consumer = this.kafka.consumer({ groupId: 'autosploit-projector' });
    this.lifecycle.registerConsumer(this.consumer);
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.env.kafkaTopic, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async (payload) => {
        try {
          await this.handle(payload);
        } catch (err) {
          this.logger.warn(`projector message failed: ${(err as Error).message}`);
        }
      },
    });
  }

  // Public so a replay consumer (D-b test, and any future re-architecture) can
  // drive the exact production upsert from a fresh group — the rebuild path is
  // the same code as the live path.
  async handle({ message }: EachMessagePayload): Promise<void> {
    const raw = message.value?.toString('utf8');
    if (!raw) return;
    let event: RawEvent;
    try {
      event = JSON.parse(raw) as RawEvent;
    } catch {
      return;
    }
    const engagementId = message.key?.toString('utf8') ?? '';
    if (event.type === 'finding' && event.data?.id) {
      await this.db
        .insert(findings)
        .values({
          engagementId,
          sourceId: event.data.id,
          severity: event.data.severity ?? '',
          title: event.data.title ?? '',
          data: event.data,
        })
        .onConflictDoUpdate({
          target: [findings.engagementId, findings.sourceId],
          set: {
            severity: event.data.severity ?? '',
            title: event.data.title ?? '',
            data: event.data,
          },
        });
    } else if (event.type === 'cost') {
      await this.db.insert(cost).values({
        engagementId,
        tokens: event.data.tokens ?? 0,
        usdMicros: Math.round((event.data.usd ?? 0) * 1e6),
      });
    }
  }
}
