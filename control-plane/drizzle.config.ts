import 'dotenv/config';
import type { Config } from 'drizzle-kit';

// The five slice-owned schemas, listed directly: drizzle-kit 0.21 loads schema
// files with its own CJS resolver, which cannot follow the NodeNext-style
// `*.js`-suffixed re-exports in src/db/schema/index.ts. Listing the files keeps
// drizzle-kit green while the barrel stays for tsc / the runtime Drizzle client.
// One writer per table is enforced in code (docs/control-plane.md §5), not by
// the schema layout.
export default {
  schema: [
    './src/domains/identity/identity.schema.ts',
    './src/domains/repos/repos.schema.ts',
    './src/domains/lifecycle/lifecycle.schema.ts',
    './src/domains/telemetry/telemetry.schema.ts',
    './src/domains/reports/reports.schema.ts',
  ],
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
