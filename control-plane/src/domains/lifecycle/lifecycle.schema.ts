import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Slice C owns engagements and is its SOLE writer — the single system of record,
// replacing the conductor's conductor.json (docs/control-plane.md §4.C, §7).
// No other slice touches this table. Telemetry (D) NEVER writes state (§5 rule 3).

// Authoritative state machine (§7). Terminal outcomes derive from the conductor
// exit code + RunResult, never guessed from the event stream.
export const engagementState = pgEnum('engagement_state', [
  'queued',
  'dispatched',
  'provisioning',
  'deploying',
  'attacking',
  'completed',
  'halted', // budget | scope | timeout — reason in halt_reason
  'failed', // provision | harness | internal — reason in fail_reason
  'tearing_down',
  'archived',
]);

export const engagements = pgTable('engagements', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  state: engagementState('state').notNull().default('queued'),
  haltReason: text('halt_reason'),
  failReason: text('fail_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
