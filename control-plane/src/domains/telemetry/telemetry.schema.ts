import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Slice D owns findings + cost. These are PROJECTIONS of the Kafka log, rebuildable
// by replaying the topic (docs/control-plane.md §8.2 event sourcing). The Postgres
// projector consumer is their sole writer; the SSE path never writes them, and D
// NEVER writes engagement state (§5 rule 3). The durable `events` log lives in the
// Kafka topic, not Postgres — no table for it here.

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id').notNull(),
    // The finding event's data.id is the ledger handle (F-001), not the row pk;
    // the projector upserts by this key so replay is idempotent (§4.D).
    sourceId: text('source_id').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    data: jsonb('data'),
    observedAt: timestamp('observed_at').defaultNow().notNull(),
  },
  (t) => ({
    // Replay-idempotency key: the projector upserts on (engagement_id, source_id).
    findingsEngagementSourceUnique: uniqueIndex(
      'findings_engagement_source_unique',
    ).on(t.engagementId, t.sourceId),
  }),
);

export const cost = pgTable('cost', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id').notNull(),
  tokens: integer('tokens').notNull().default(0),
  usdMicros: integer('usd_micros').notNull().default(0),
  observedAt: timestamp('observed_at').defaultNow().notNull(),
});

// Immutable retained trail of every tool call (§4.D security record). Append-only:
// the audit consumer INSERTs, and no code path in the plane ever UPDATEs or
// DELETEs this table — a tool-call record cannot be rewritten or purged via the API.
export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id').notNull(),
  eventType: text('event_type').notNull(),
  ts: timestamp('ts').notNull(),
  payload: jsonb('payload').notNull(),
});
