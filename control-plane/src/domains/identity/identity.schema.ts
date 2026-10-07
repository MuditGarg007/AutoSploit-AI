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
  // Keyed HMAC-SHA256 of the token this row's current one just replaced. A
  // presented token matching THIS (not refresh_token_hash) is a replayed,
  // already-rotated token → theft signal → the whole session (token family) is
  // revoked. Null until the first rotation.
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
