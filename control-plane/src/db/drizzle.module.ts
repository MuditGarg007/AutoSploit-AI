import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
import { EnvService } from '../config/env.service.js';
import * as schema from './schema/index.js';

const { Pool } = pkg;

export const DRIZZLE = Symbol('DRIZZLE');
export type Db = ReturnType<typeof drizzle<typeof schema>>;

// The Drizzle handle wraps one Pool; this token exposes that same Pool so
// app.close() can release it. Without this, tests (and graceful deploy drains)
// hang on open Postgres connections.
const PG_POOL = Symbol('PG_POOL');

// Shuts the pool down on app.close()/shutdown so tests (and graceful deploy
// drains) release Postgres connections instead of hanging on an open pool.
@Injectable()
export class DrizzlePoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

// One pool, one Drizzle handle, injected into every slice's sole-writer service.
// Row-level user scoping lives in the queries (docs/control-plane.md §9.1), not here.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [EnvService],
      useFactory: (env: EnvService) => new Pool({ connectionString: env.databaseUrl }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: InstanceType<typeof Pool>): Db => drizzle(pool, { schema }),
    },
    DrizzlePoolShutdown,
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
