import {
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SessionGuard } from '../../../core/guards/session.guard.js';
import { CurrentUser } from '../../../core/guards/current-user.decorator.js';
import type { AuthenticatedUser } from '../../../core/guards/session.guard.js';
import { LifecycleService } from '../../lifecycle/lifecycle.service.js';
import { EnvService } from '../../../config/env.service.js';
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
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  // GET /engagements/:id/stream — authorize ownership, replay recent backlog from
  // the Redis last-mile (Last-Event-ID), then tail live (docs/control-plane.md §4.D).
  @Get()
  @UseGuards(SessionGuard)
  async stream(
    @CurrentUser() auth: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('last_event_id') lastEventIdQuery: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Ownership before any byte leaves: 401/404 via assertOwned.
    await this.lifecycle.assertOwned(id, auth.id);

    // Resume cursor: the Last-Event-ID header is set by the browser's native
    // EventSource reconnect, but a client that must rebuild the EventSource (to
    // swap in a refreshed access token) cannot set request headers, so it passes
    // the same cursor as a `last_event_id` query param. Header wins when both are
    // present.
    const resumeFrom = lastEventId ?? lastEventIdQuery;

    // Raw SSE: hijack the Fastify reply so the async iterator can write directly
    // to the socket (avoids @Sse() adapter quirks on fastify 4.28.1, §9.1 note).
    const raw = reply.raw;
    reply.hijack();

    // CORS: the global enableCors layer runs in the Fastify reply lifecycle
    // (onRequest/onSend), which hijack() bypasses — raw.writeHead emits only the
    // literal header object. A cross-origin EventSource(url, {withCredentials:true})
    // needs ACAO=exact-origin + ACAC=true on THIS 200 response or the browser
    // blocks it → onerror → "Reconnecting" loop. Echo the request Origin only when
    // it is in the allowlist; never reflect an arbitrary origin with credentials.
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    const origin = req.headers.origin;
    if (origin && this.env.frontendUrls.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Vary'] = 'Origin';
    }
    raw.writeHead(200, headers);

    const abort = new AbortController();
    const onClose = () => abort.abort();
    raw.on('close', onClose);
    req.raw.on('close', onClose);

    try {
      for await (const frame of this.gateway.subscribe(
        id,
        resumeFrom ?? null,
        abort.signal,
      )) {
        if (abort.signal.aborted) break;
        if (!frame.id) {
          // Idle keep-alive tick.
          raw.write(': ping\n\n');
          continue;
        }
        // Unnamed "message" event carrying the full event envelope. The browser
        // dispatches frames WITH an `event:` field only to addEventListener(type)
        // listeners — es.onmessage never fires for them — and the client folds
        // {type, ts, data} envelopes (the shape the harness emits and the mock
        // replays). So: no `event:` line, and the payload wraps the inner data.
        raw.write(
          `id: ${frame.id}\ndata: ${JSON.stringify({
            type: frame.event,
            ts: frame.ts,
            data: JSON.parse(frame.data),
          })}\n\n`,
        );
      }
    } finally {
      raw.removeListener('close', onClose);
      req.raw.removeListener('close', onClose);
      if (!raw.destroyed) raw.end();
    }
  }
}
