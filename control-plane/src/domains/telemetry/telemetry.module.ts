import { Module } from '@nestjs/common';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestService } from './ingest/ingest.service.js';
import { SseController } from './sse/sse.controller.js';
import { SseGateway } from './sse/sse.gateway.js';
import { ProjectorConsumer } from './consumers/projector.consumer.js';
import { SseBridgeConsumer } from './consumers/sse-bridge.consumer.js';

// D · Telemetry — ingest AND SSE fan-out are the SAME slice because they own one
// event log; splitting them would put the writer and reader of one stream in two
// services (docs/control-plane.md §4.D). Internally the log is split by requirement
// (§8.2): a Kafka topic is the durable backbone, Redis Streams the SSE last-mile.
@Module({
  controllers: [IngestController, SseController],
  providers: [
    IngestService,
    SseGateway,
    SseBridgeConsumer, // topic → Redis last-mile (feeds SSE) — P4a
    ProjectorConsumer, // topic → findings / cost projections — P4b
    // + S3 sink (Kafka Connect) and audit trail are P4b (config, not code here).
  ],
})
export class TelemetryModule {}
