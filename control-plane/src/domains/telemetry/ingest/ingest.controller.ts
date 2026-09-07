import { Body, Controller, HttpCode, Inject, Optional, Param, Post, UseGuards } from '@nestjs/common';
import { IngestService } from './ingest.service.js';
import { IngestTokenGuard } from './ingest-token.guard.js';
import type { Metrics } from '../../../core/observability/metrics.js';

// The ONE inbound edge from a sandbox (docs/control-plane.md §3 rule 4, §6). The
// endpoint is identical across Phase A (worker relays conductor stdout) and Phase B
// (attacker pod POSTs directly) — it never changes between them.
@Controller('engagements/:id/events')
export class IngestController {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    // Optional so the controller is constructible without the @Global metrics
    // provider; under DI it is always present.
    @Optional() @Inject('METRICS') private readonly metrics?: Metrics,
  ) {}

  // Eats the frozen { ts, type, data } stream (harness.md §7). Auth = per-engagement
  // ingest token minted by C, validated here (§8.1). Fail-closed on bad token or
  // schema violation. 202 = accepted into the log; the projector lands it later.
  @Post()
  @HttpCode(202)
  @UseGuards(IngestTokenGuard)
  async push(@Param('id') id: string, @Body() event: unknown): Promise<{ accepted: true }> {
    await this.ingest.push(id, event);
    // Count accepted events by TYPE (bounded set: phase/tool/finding/cost), never
    // by engagement_id (that is the trace's job, §6.1). Only reached on accept —
    // a rejected token/schema throws in the guard/service before here.
    try {
      const type = (event as { type?: string })?.type ?? 'unknown';
      this.metrics?.ingestAccepted.inc({ type });
    } catch {
      // fail-open — visibility only
    }
    return { accepted: true };
  }
}
