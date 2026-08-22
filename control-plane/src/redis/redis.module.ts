import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { EnvService } from '../config/env.service.js';

export const REDIS = Symbol('REDIS');

// The SSE last-mile Redis client (docs/control-plane.md §8.2) plus a connection
// for the stream XADD/XRANGE/XREAD operations in the bridge + gateway. BullMQ
// creates its own ioredis connections (via its `connection` option), so this is
// a separate handle owned by the telemetry slice.
//
// Shutdown uses `disconnect()` (not `quit()`): a live SSE subscriber keeps the
// gateway suspended in XREAD BLOCK, so a graceful QUIT would wait on that blocked
// command forever. disconnect() drops the connection immediately, which rejects
// the pending read and unwinds the stream loop.
@Injectable()
export class RedisProvider implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis?.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [EnvService],
      useFactory: (env: EnvService): Redis | null => {
        if (!env.redisUrl) return null;
        const client = new Redis(env.redisUrl, { lazyConnect: true });
        // The app must boot even when Redis is down (pre-D slices, health checks).
        // A failed connection must not become an unhandled 'error' event that
        // crashes or log-spams — the SSE path checks liveness on use.
        client.on('error', () => undefined);
        void client.connect().catch(() => undefined);
        return client;
      },
    },
    RedisProvider,
  ],
  exports: [REDIS],
})
export class RedisModule {}
