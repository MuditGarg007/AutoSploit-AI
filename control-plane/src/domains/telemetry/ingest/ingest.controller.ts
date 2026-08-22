import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { IngestService } from './ingest.service.js';
import { IngestTokenGuard } from './ingest-token.guard.js';

// The ONE inbound edge from a sandbox (docs/control-plane.md §3 rule 4, §6). The
// endpoint is identical across Phase A (worker relays conductor stdout) and Phase B
// (attacker pod POSTs directly) — it never changes between them.
@Controller('engagements/:id/events')
export class IngestController {
  constructor(@Inject(IngestService) private readonly ingest: IngestService) {}

  // Eats the frozen { ts, type, data } stream (harness.md §7). Auth = per-engagement
  // ingest token minted by C, validated here (§8.1). Fail-closed on bad token or
  // schema violation. 202 = accepted into the log; the projector lands it later.
  @Post()
  @HttpCode(202)
  @UseGuards(IngestTokenGuard)
  async push(@Param('id') id: string, @Body() event: unknown): Promise<{ accepted: true }> {
    await this.ingest.push(id, event);
    return { accepted: true };
  }
}
