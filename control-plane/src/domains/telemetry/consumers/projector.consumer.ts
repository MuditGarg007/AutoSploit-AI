import { Injectable } from '@nestjs/common';

// Consumer group off the Kafka topic (P4b). Projects `finding` / `cost` events into
// the Postgres tables — these tables are a PROJECTION of the log, rebuildable by
// replay (docs/control-plane.md §8.2). Sole writer of findings / cost. Never writes
// engagement state (§5 rule 3).
@Injectable()
export class ProjectorConsumer {
  // TODO(P4b): consume topic -> upsert findings / cost. Idempotent for replay.
}
