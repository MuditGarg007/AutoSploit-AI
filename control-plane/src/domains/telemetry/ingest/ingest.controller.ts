import { Body, Controller, Param, Post } from '@nestjs/common';
import { IngestService } from './ingest.service.js';

// The ONE inbound edge from a sandbox (docs/control-plane.md §3 rule 4, §6). The
// endpoint is identical across Phase A (worker relays conductor stdout) and Phase B
// (attacker pod POSTs directly) — it never changes between them.
@Controller('engagements/:id/events')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  // Eats the frozen { ts, type, data } stream (harness.md §7). Auth = per-engagement
  // ingest token minted by C, validated here (§8.1). Fail-closed on bad token or
  // schema violation.
  @Post()
  push(@Param('id') _id: string, @Body() _event: unknown): void {
    // TODO(P4a): validate ingest token, validate vs Schema Registry, produce to
    // the Kafka topic keyed by engagement_id. Ingest does NOT write Postgres.
  }
}
