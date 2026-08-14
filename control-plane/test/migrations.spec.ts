import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pkg;

// Component 0 gate: "migrations apply from clean" (docs/control-plane.md §12).
// Real Postgres via Testcontainers in CI, not a mock (§9.1). Proves the first
// migration creates every table the five slices own (§4 table map).
describe('migrations apply from clean', () => {
  let pg: PostgreSqlContainer;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('applies the migration and creates all slice-owned tables', async () => {
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const db = drizzle(pool);

    const migrationsDir = path.resolve(
      fileURLToPath(import.meta.url),
      '../../src/db/migrations',
    );
    await migrate(db, { migrationsFolder: migrationsDir });

    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = rows.map((r) => r.tablename).sort();

    expect(tables).toEqual(
      [
        'cost',
        'engagements',
        'findings',
        'github_tokens',
        'repo_cache',
        'reports',
        'sessions',
        'users',
      ].sort(),
    );

    // Migration 0001: sessions gained the rotation marker column (A, §4.A).
    const { rows: sessionCols } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'sessions'`,
    );
    expect(sessionCols.map((c) => c.column_name)).toContain('rotated_at');

    await pool.end();
  });
});
