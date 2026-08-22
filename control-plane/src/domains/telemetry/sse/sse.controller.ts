import {
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SessionGuard } from '../../../core/guards/session.guard.js';
import { CurrentUser } from '../../../core/guards/current-user.decorator.js';
import type { AuthenticatedUser } from '../../../core/guards/session.guard.js';
import { LifecycleService } from '../../lifecycle/lifecycle.service.js';
import { SseGateway } from './sse.gateway.js';

// Read end of the log. Raw Nest route (NOT a tRPC subscription — §9.1) so native
// Fastify SSE is preserved. Client subscribes by engagement_id. Ownership is
// enforced here (LifecycleService.assertOwned — a read of C's rows for
// authorization only; D never writes engagement state, §5 rule 3).
@Controller('engagements/:id/stream')
export class SseController {
  constructor(
    @Inject(SseGateway) private readonly gateway: SseGateway,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
  ) {}

  // GET /engagements/:id/stream — authorize ownership, replay recent backlog from
  // the Redis last-mile (Last-Event-ID), then tail live (docs/control-plane.md §4.D).
  @Get()
  @UseGuards(SessionGuard)
  async stream(
    @CurrentUser() auth: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Ownership before any byte leaves: 401/404 via assertOwned.
    await this.lifecycle.assertOwned(id, auth.id);

    // Raw SSE: hijack the Fastify reply so the async iterator can write directly
    // to the socket (avoids @Sse() adapter quirks on fastify 4.28.1, §9.1 note).
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abort = new AbortController();
    const onClose = () => abort.abort();
    raw.on('close', onClose);
    req.raw.on('close', onClose);

    try {
      for await (const frame of this.gateway.subscribe(
        id,
        lastEventId ?? null,
        abort.signal,
      )) {
        if (abort.signal.aborted) break;
        if (!frame.id) {
          // Idle keep-alive tick.
          raw.write(': ping\n\n');
          continue;
        }
        raw.write(`id: ${frame.id}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`);
      }
    } finally {
      raw.removeListener('close', onClose);
      req.raw.removeListener('close', onClose);
      if (!raw.destroyed) raw.end();
    }
  }
}
