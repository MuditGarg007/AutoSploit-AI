import { Controller, Get, Param } from '@nestjs/common';
import { SseGateway } from './sse.gateway.js';

// Read end of the log. Raw Nest route (NOT a tRPC subscription — §9.1) so native
// Fastify SSE is preserved. Client subscribes by engagement_id.
@Controller('engagements/:id/stream')
export class SseController {
  constructor(private readonly gateway: SseGateway) {}

  // GET /engagements/:id/stream — authorize ownership, replay recent backlog from
  // the Redis last-mile (Last-Event-ID), then tail live (docs/control-plane.md §4.D).
  @Get()
  stream(@Param('id') _id: string): void {
    // TODO(P4a): ownership guard, open SSE, replay + live tail from Redis Stream.
  }
}
