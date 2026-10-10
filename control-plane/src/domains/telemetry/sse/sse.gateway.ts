import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../../redis/redis.module.js';

export interface SseFrame {
  id: string; // Redis Stream auto-id (ms-seq) — the Last-Event-ID cursor
  event: string;
  ts: string;
  data: string;
}

// Tails the per-engagement Redis Stream (the SSE last-mile) and pushes to the
// client. Sub-second latency, short retention, reconnect window (docs/control-plane.md
// §8.2). Fresh subscribe or stale cursor → XRANGE replays the recent backlog
// (bounded by maxlen); with Last-Event-ID → XRANGE (cursor is exclusive) replays
// only missed frames; then XREAD BLOCK 5000 doubles as the abort tick — the loop
// checks the AbortSignal and emits a keep-alive `: ping` when idle. Cleanup on
// abort.
@Injectable()
export class SseGateway {
  private readonly logger = new Logger(SseGateway.name);

  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async *subscribe(
    engagementId: string,
    lastEventId: string | null,
    signal: AbortSignal,
  ): AsyncIterable<SseFrame> {
    if (!this.redis) return;
    const stream = `events:${engagementId}`;

    // Replay: fresh subscribe → whole backlog (bounded by MAXLEN ~1000); reconnect
    // with Last-Event-ID → only what came after the cursor.
    let cursor = lastEventId ?? '-';
    if (lastEventId) {
      const range = await this.redis.xrange(stream, `(${lastEventId}`, '+');
      for (const [id, fields] of range) {
        yield this.toFrame(id, fields);
      }
      cursor = range.length ? range[range.length - 1][0] : lastEventId;
    } else {
      const range = await this.redis.xrange(stream, '-', '+');
      for (const [id, fields] of range) {
        yield this.toFrame(id, fields);
      }
      cursor = range.length ? range[range.length - 1][0] : '-';
    }

    // Live tail: XREAD BLOCK 5000 (ms) doubles as the abort tick. An empty read
    // yields a keep-alive `: ping` comment frame so proxies don't close idle
    // connections. The gateway loop checks the signal each tick and cleans up.
    let tailCursor = cursor === '-' ? '$' : cursor;
    while (!signal.aborted) {
      let res;
      try {
        res = await this.redis.xread(
          'BLOCK',
          5000,
          'STREAMS',
          stream,
          tailCursor,
        );
      } catch {
        // The connection was closed under us (shutdown/disconnect) — stop cleanly.
        break;
      }
      if (signal.aborted) break;
      if (!res) {
        // Idle tick → keep-alive ping.
        yield { id: '', event: '', ts: '', data: '' }; // caller emits ": ping"
        continue;
      }
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          yield this.toFrame(id, fields);
        }
      }
      // Advance the cursor to the last seen id so the next XREAD resumes after it.
      const last = res[0]?.[1][res[0][1].length - 1]?.[0];
      if (last) tailCursor = last;
    }
  }

  private toFrame(id: string, fields: string[]): SseFrame {
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
    return {
      id,
      event: map.get('type') ?? '',
      ts: map.get('ts') ?? '',
      data: map.get('data') ?? '{}',
    };
  }
}
