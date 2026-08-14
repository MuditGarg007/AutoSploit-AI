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
  refreshTokenHash: text('refresh_token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  // Rotation: each refresh use rotates the token and stamps this; a presented
  // token whose hash matches a row with a NEWER rotated_at is a reuse → revoke.
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
