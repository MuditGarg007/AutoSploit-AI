import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Slice B owns repo_cache ONLY (optional cache — no authoritative state).
// Sole writer of this table (docs/control-plane.md §4.B).
export const repoCache = pgTable('repo_cache', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  fullName: text('full_name').notNull(),
  deployable: boolean('deployable'), // null = not yet probed
  cachedAt: timestamp('cached_at').defaultNow().notNull(),
});
