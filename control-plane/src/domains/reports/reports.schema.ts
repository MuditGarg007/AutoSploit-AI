import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Slice E owns reports and is its sole writer (docs/control-plane.md §4.E). Holds
// object-store refs (memory bundle, raw JSONL log, rendered report); the artifacts
// themselves live in S3/MinIO, served via presigned URLs.
export const reports = pgTable('reports', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id').notNull().unique(),
  renderedKey: text('rendered_key'), // S3 object key
  rawLogKey: text('raw_log_key'),
  memoryBundleKey: text('memory_bundle_key'),
  assembledAt: timestamp('assembled_at').defaultNow().notNull(),
});
