import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Slice A owns these three tables and is their SOLE writer (docs/control-plane.md §4).
// github_tokens holds CIPHERTEXT only — plaintext never lands here (§12 gate A).

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  githubId: text('github_id').notNull().unique(),
  login: text('login').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  // Keyed HMAC-SHA256 of the CURRENT (live) refresh token.
  refreshTokenHash: text('refresh_token_hash').notNull(),
  // Deprecated. Held the prior refresh-token hash back when refresh rotated the
  // token on every use and a replayed "prev" token revoked the whole session.
  // That scheme logged browsers out within minutes (any multi-tab / reconnect
  // race replayed a just-rotated cookie), so refresh is now non-rotating
  // (identity.service.refreshSession) and nothing writes this column. Kept
  // nullable so no migration is needed; drop it in a later cleanup.
  prevRefreshTokenHash: text('prev_refresh_token_hash'),
  expiresAt: timestamp('expires_at').notNull(),
  // Rotation in place: the session id is stable for the login's lifetime; each
  // refresh overwrites refresh_token_hash on THIS row (no new row per refresh)
  // and stamps rotated_at with the last rotation time.
  rotatedAt: timestamp('rotated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const githubTokens = pgTable('github_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  // Vault Transit ciphertext (vault:v1:...). The key never enters the app.
  ciphertext: text('ciphertext').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
