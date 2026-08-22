import { Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module.js';
import { LifecycleModule } from '../lifecycle/lifecycle.module.js';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestService } from './ingest/ingest.service.js';
import { IngestTokenGuard } from './ingest/ingest-token.guard.js';
import { SseController } from './sse/sse.controller.js';
import { SseGateway } from './sse/sse.gateway.js';
import { ProjectorConsumer } from './consumers/projector.consumer.js';
import { SseBridgeConsumer } from './consumers/sse-bridge.consumer.js';
import { AuditConsumer } from './consumers/audit.consumer.js';
import {
  kafkaProvider,
  kafkaProducerProvider,
  kafkaAdminProvider,
} from './kafka/kafka.providers.js';
import { KafkaBootstrap } from './kafka/kafka-bootstrap.js';
import { SchemaRegistryService } from './kafka/schema-registry.service.js';
import { EventSchemaService } from './kafka/event-schema.service.js';
import { TelemetryConsumerLifecycle } from './kafka/telemetry-consumer.lifecycle.js';

// D · Telemetry — ingest AND SSE fan-out are the SAME slice because they own one
// event log; splitting them would put the writer and reader of one stream in two
// services (docs/control-plane.md §4.D). Internally the log is split by requirement
// (§8.2): a Kafka topic is the durable backbone, Redis Streams the SSE last-mile.
@Module({
  imports: [LifecycleModule, RedisModule],
  controllers: [IngestController, SseController],
  providers: [
    IngestService,
    IngestTokenGuard,
    SseGateway,
    kafkaProvider,
    kafkaProducerProvider,
    kafkaAdminProvider,
    KafkaBootstrap,
    SchemaRegistryService,
    EventSchemaService,
    TelemetryConsumerLifecycle,
    SseBridgeConsumer, // topic → Redis last-mile (feeds SSE) — D-a
    ProjectorConsumer, // topic → findings / cost projections — D-b
    AuditConsumer, // topic → immutable tool-call trail — D-b
  ],
  exports: [EventSchemaService],
})
export class TelemetryModule {}
