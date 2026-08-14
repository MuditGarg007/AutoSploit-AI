import { Injectable } from '@nestjs/common';

// Tails the per-engagement Redis Stream (the SSE last-mile) and pushes to the
// client. Sub-second latency, short retention, reconnect window (docs/control-plane.md
// §8.2). The first slice likely to split out of the monolith on connection-scaling
// pressure (§11) — kept as a clean read end to make that cheap.
@Injectable()
export class SseGateway {
  // TODO(P4a): subscribe(engagementId, lastEventId) -> async iterable of events.
}
