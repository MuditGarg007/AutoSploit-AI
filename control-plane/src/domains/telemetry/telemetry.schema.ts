import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Slice D owns findings + cost. These are PROJECTIONS of the Kafka log, rebuildable
// by replaying the topic (docs/control-plane.md §8.2 event sourcing). The Postgres
// projector consumer is their sole writer; the SSE path never writes them, and D
// NEVER writes engagement state (§5 rule 3). The durable `events` log lives in the
// Kafka topic, not Postgres — no table for it here.

export const findings = pgTable('findings', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  data: jsonb('data'),
  observedAt: timestamp('observed_at').defaultNow().notNull(),
});

export const cost = pgTable('cost', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id').notNull(),
  tokens: integer('tokens').notNull().default(0),
  usdMicros: integer('usd_micros').notNull().default(0),
  observedAt: timestamp('observed_at').defaultNow().notNull(),
});
