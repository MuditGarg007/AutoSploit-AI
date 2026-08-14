import { Injectable } from '@nestjs/common';

// Consumer group off the Kafka topic (P4a). Pushes each engagement's events into a
// short-retention Redis Stream that the SSE gateway tails (docs/control-plane.md §4.D).
// Own offset, independent of the other consumer groups.
@Injectable()
export class SseBridgeConsumer {
  // TODO(P4a): consume topic -> XADD to Redis Stream keyed by engagement_id.
}
