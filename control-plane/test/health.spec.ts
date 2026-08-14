import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pkg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';

const { Pool } = pkg;

// Component 0 gate: GET /health returns 200 with a live DB check — proven
// against a real Postgres in CI, not a mock (docs/control-plane.md §12, §9.1).
// The app boots against the container's DATABASE_URL; the shutdown hook in
// DrizzleModule releases the pool on app.close() so the process can exit.
describe('GET /health against real Postgres', () => {
  let pg: PostgreSqlContainer;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();

    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    await migrate(drizzle(pool), {
      migrationsFolder: path.resolve(
        fileURLToPath(import.meta.url),
        '../../src/db/migrations',
      ),
    });
    await pool.end();

    process.env.DATABASE_URL = pg.getConnectionUri();
    // Component A required vars — IdentitySlice/EnvService fail-fast at boot
    // (docs/control-plane.md §4.A). Dummy values are fine here; health doesn't
    // touch OAuth/Vault.
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/auth/callback';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';
    process.env.VAULT_TOKEN = 'test-root-token';
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
    );
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('returns 200 with liveness + DB connectivity', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up' });
  });
});
