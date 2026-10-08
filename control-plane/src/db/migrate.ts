/**
 * Standalone schema-migration runner for the Helm pre-install/pre-upgrade hook
 * (deploy/helm/control-plane/templates/migrate-job.yaml). Applies the drizzle SQL
 * migrations in ./migrations to the DATABASE_URL target using drizzle-orm's
 * programmatic migrator.
 *
 * Why not `drizzle-kit migrate`: drizzle-kit is a devDependency and the CLI needs
 * both drizzle.config.ts and the TS schema tree, none of which ship in the runtime
 * image (it carries dist/ only). drizzle-orm and pg are runtime dependencies, and
 * the Dockerfile copies the SQL folder next to this compiled file, so the single
 * long-lived app image can also run migrations with `node dist/db/migrate.js` — no
 * extra image, no drizzle-kit at runtime.
 *
 * Idempotent: the migrator records applied migrations in drizzle's
 * __drizzle_migrations table and skips any already present, so re-running the hook
 * on every `helm upgrade` is a safe no-op once the schema is current.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const { Pool } = pkg;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is required');
    process.exit(1);
  }

  // The SQL migrations ship beside this compiled file at dist/db/migrations (the
  // Dockerfile copies src/db/migrations there, since tsc does not emit .sql/.json).
  // MIGRATIONS_DIR overrides it for a local run against the source tree.
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? resolve(here, 'migrations');

  const pool = new Pool({ connectionString: url });
  try {
    const db = drizzle(pool);
    console.log(`[migrate] applying migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log('[migrate] migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
