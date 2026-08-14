import { Injectable } from '@nestjs/common';

// Write end of the event log. Validates the per-engagement ingest token signature
// (shared signing key with C, zero runtime call, fail-closed — §8.1), validates the
// event against Schema Registry, and produces to the Kafka topic (partition key =
// engagement_id). Never writes Postgres — the projector consumer does (§4.D).
@Injectable()
export class IngestService {
  // TODO(P4a): validateIngestToken, produce(event).
}
