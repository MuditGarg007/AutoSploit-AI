# Component D — Telemetry (P4): Implementation Plan

> **Status: ✅ IMPLEMENTED (2026-08-20)** — all gates green. D-a, D-b, S3 sink,
> migration, contract border all passing; full control-plane suite 9 files / 30
> tests green (serial). See `docs/handoff-component-d.md` for the completion log.

Target: `docs/control-plane.md` §12 Component D, §4.D, §8.1, §8.2. Two gates:
**D-a** (live path: authenticated ingest → Redpanda → SSE bridge → Redis last-mile → SSE gateway with replay) and **D-b** (durable consumers: Postgres projector, audit trail, Kafka Connect S3 sink).

## Binding decisions (from user)

1. **S3 sink = Kafka Connect worker** (spec-literal). A Connect container + S3-sink connector config against MinIO in CI. No custom batched archiver.
2. **Schema gate = app-level ajv validation + registry registration.** ajv-validate every event at ingest (fail-closed 422 before produce) AND register the generated JSON Schema as a versioned subject in Redpanda's Schema Registry. Redpanda's broker-side JSON produce validation is immature, so the registry is the versioned source of truth and ajv is the enforcement point — the registry check itself does not gate produce.

## What already exists (verified)

- Slice C is complete: `IngestTokenService` (mints/verifies JWT HS256, `sub`=engagement_id, `type`=ingest, `scope`=events), `LifecycleService.assertOwned` (ownership read), both **exported** from `LifecycleModule`.
- Telemetry stubs: `ingest/ingest.controller.ts` (POST `/engagements/:id/events`), `ingest/ingest.service.ts`, `sse/sse.controller.ts` (GET `/engagements/:id/stream`), `sse/sse.gateway.ts`, `consumers/sse-bridge.consumer.ts`, `consumers/projector.consumer.ts` — all TODO bodies.
- `telemetry.schema.ts` already has `findings` + `cost` tables (migration 0000, applied in CI).
- `packages/contracts` generates TS types from `harness/contracts/contract.schema.json` (drift-spec-guarded). **No JSON Schema exists yet** — the descriptor's `fields`/`required` arrays + Python `events.py` `__required_keys__` define the required-key semantics.
- `lifecycle.spec.ts` stubs global fetch, so the real ingest route is never exercised there — the new telemetry spec is self-contained.
- EnvService reads env fail-fast; `.env.example` already carries commented `KAFKA_BROKERS`, `SCHEMA_REGISTRY_URL`, `S3_*` placeholders.
- Codebase conventions: NodeNext `.js` import suffixes, Nest DI with token symbols, lifecycle providers mirroring `EngagementWorkerLifecycle` (BullMQ Worker + shutdown), Testcontainers per-spec, comments explaining the §-references, fail-fast-but-bootable pattern for optional infra (`INGEST_TOKEN_SIGNING_KEY` precedent).

## New dependencies

- `kafkajs` ^2.2.4 — producer + consumer groups (sse-bridge, projector, audit).
- `ajv` ^8 + `ajv-formats` — runtime event validation against the generated JSON Schema (draft 2020-12, `format: date-time` for `ts`).
- `@testcontainers/redpanda` (dev) — real broker + registry in CI, per §9.1 "real Postgres/Redis in CI, not mocks".
- `minio` (dev) — MinIO test assertion client (list/GET archived objects).
- **No** `@kafkajs/confluent-schema-registry` — schema registration is one idempotent REST call to `SCHEMA_REGISTRY_URL`; consumers read raw JSON (no wire format), so the encode/decode lib buys nothing.
- Connect/MinIO run as GenericContainer images in tests (no new npm deps beyond `minio`).

## 1. Contract border — generate a JSON Schema (packages/contracts)

**Files:**

- `scripts/generate.mjs` — extend to additionally emit `src/event-schema.ts` from `contract.schema.json`: a draft-2020-12 JSON Schema with
  - envelope: `ts` (string, `format: date-time`), `type` (`enum` of the 7), `data` (object), all required;
  - per-type `allOf` branches: `if type === X then data requires the per-type required keys` with property types derived from the descriptor hints (`string|integer|number|boolean|object|array<…>|null`); `halt` gets no required keys (all optional — matches `events.py`).
  - shape: `export const eventSchema = {…} as const;`
- `src/index.ts` — regenerated; adds `export { eventSchema } from './event-schema.js';`
- `src/event-schema.ts` — new generated file.
- `test/drift.spec.ts` — extend to regenerate + diff `event-schema.ts` too (same gate as `index.ts`).

Keeps the "generated, never hand-mirrored" invariant; the registry subject and the ajv validator both derive from one artifact.

## 2. Env + deps (control-plane)

**`src/config/env.service.ts`** — new optional-but-fail-fast-on-use vars (pattern: `ingestTokenSigningKey`):

- `kafkaBrokers` (`KAFKA_BROKERS`, default `''` = disabled), `schemaRegistryUrl` (`SCHEMA_REGISTRY_URL`, default `''`), `kafkaTopic` (`KAFKA_TOPIC`, default `autosploit.events`), `kafkaClientId` (`KAFKA_CLIENT_ID`, default `control-plane`), `kafkaPartitions` (fixed 3).
- `s3Endpoint`/`s3Bucket`/`s3AccessKey`/`s3SecretKey` (`S3_ENDPOINT` default `http://localhost:9000`, bucket `autosploit-reports`, keys optional) — for the Connect config + test assertions.

**`.env.example`** — fill the commented `KAFKA_*` / `SCHEMA_REGISTRY_URL` / `S3_*` placeholders with local defaults.

**`package.json`** — add deps above.

## 3. Schema (D-owned tables) + migration

**`src/domains/telemetry/telemetry.schema.ts`:**

- `findings`: add `sourceId: text('source_id')` + unique index on `(engagement_id, source_id)` — the projector upserts by this key so replay is idempotent (finding event `data.id` is the ledger handle F-001, not the row pk).
- New `auditLog` table: `id` uuid defaultRandom pk, `engagementId` uuid notNull, `eventType` text notNull, `ts` timestamp notNull, `payload` jsonb notNull. Append-only (INSERT only; no UPDATE/DELETE path in code).

**Migration:** `bun db:generate` → `0002_*.sql` (add column + unique index + audit_log table). **`test/migrations.spec.ts`**: add `audit_log` to the expected table list.

## 4. Kafka + registry infra (TelemetryModule internals)

New `kafka/` dir in the telemetry slice:

- `kafka.providers.ts` — token factories (all `inject: [EnvService]`, disabled → `null` when `kafkaBrokers === ''`):
  - `KAFKA` — `Kafka` instance (`clientId`, `brokers` split).
  - `KAFKA_PRODUCER` — `kafka.producer()` (connect + createTopics via admin at `onApplicationBootstrap`; 3 partitions, key=engagement_id preserves per-engagement order).
  - `KAFKA_ADMIN` for topic creation.
- `schema-registry.service.ts` — idempotent registration: `GET /subjects/autosploit.events-value/versions`; if absent (or version mismatch), `POST /subjects/autosploit.events-value/versions` `{schemaType: 'JSON', schema: JSON.stringify(eventSchema)}`. Runs at bootstrap when configured; log-only on failure (registry is versioning, not the enforcement gate).
- `event-schema.service.ts` — compiles `eventSchema` once with `ajv` + `ajv-formats`; exposes `validate(event): {ok, errors?}`.
- `telemetry-consumer.lifecycle.ts` — `OnApplicationShutdown` closing producer + all consumers (mirror of `EngagementWorkerLifecycle`).

## 5. D-a write end — ingest

**`ingest/ingest-token.guard.ts`** (new, reusable `CanActivate`): reads `Authorization: Bearer`, calls `IngestTokenService.verify` (imported from LifecycleModule), checks `payload.sub === route :id`. **401** invalid/expired signature, **403** valid-but-mis-scoped. Fail-closed on missing header.

**`ingest/ingest.service.ts`:**

1. Guard already validated the token; service validates the body with `event-schema.service` → **422 UnprocessableEntity** on violation (list first error).
2. Produces `{key: engagementId, value: JSON.stringify(event)}` to `kafkaTopic` → **202 Accepted**. Never touches Postgres (projector's job).
3. When Kafka disabled: **503** `ingest disabled` (fail-closed, never silent-drop).

**`ingest/ingest.controller.ts`**: `@UseGuards(IngestTokenGuard)` on the existing `POST /engagements/:id/events`; body stays a single frozen envelope (Phase A relay and Phase B pod POST the same shape — §6 seam unchanged).

## 6. D-a last-mile + read end — SSE

**`consumers/sse-bridge.consumer.ts`** (implement): group `autosploit-sse-bridge`, `fromBeginning: false`. Each message → ioredis `XADD events:{engagementId} MAXLEN ~ 1000 * type <t> data <json> ts <ts>`. Redis stream auto-id (`ms-seq`) is the SSE `id` and the `Last-Event-ID` cursor.

**`sse/sse.gateway.ts`** (implement) — `subscribe(engagementId, lastEventId): AsyncIterable<SseFrame>`:

- Fresh subscribe or stale cursor: `XRANGE events:{id} - +` (bounded by maxlen) → replay recent backlog.
- With `Last-Event-ID`: `XRANGE events:{id} (<cursor> +` (exclusive) → replay missed.
- Then `XREAD BLOCK 5000 STREAMS events:{id} $` loop; short block doubles as the abort tick — loop checks an `AbortSignal` and emits a keep-alive `: ping` comment when idle. Cleans up on abort.
- Frame: `{id: <redisId>, event: <type>, data: <data json>}`.

**`sse/sse.controller.ts`** (implement): `@UseGuards(SessionGuard)` + `LifecycleService.assertOwned(:id, userId)` (imported from LifecycleModule — a read of C's rows for authorization, allowed; keeps D's "never writes state" intact). Uses `@Res()` + Fastify `reply.hijack()`, writes `text/event-stream` / `no-cache` headers to `reply.raw`, streams frames, honors the `Last-Event-ID` header, ends on request `close`. Raw route per the §9.1 note (not a tRPC subscription; avoids `@Sse()` adapter quirks on fastify 4.28.1).

## 7. D-b — projector + audit consumers

**`consumers/projector.consumer.ts`** (implement): group `autosploit-projector`. Sole writer of `findings`/`cost`:

- `finding` → upsert `findings` by `(engagement_id, source_id)` (severity/title from payload, `data` = full payload, `source_id` = `data.id`) — replay-idempotent without truncate.
- `cost` → append row (`tokens`, `usd_micros = Math.round(usd * 1e6)`).
- Never touches engagement state (§5 rule 3).

**`consumers/audit.consumer.ts`** (new): group `autosploit-audit`. INSERT-only into `audit_log` for `tool_call` + `tool_result` (the security record per §4.D "immutable retained trail of every tool call"). Payload = whole envelope; `ts` from `event.ts`. No UPDATE/DELETE anywhere.

**Replay proof (exit gate):** a fresh consumer group id + `fromBeginning: true` reads the whole topic — the D-b spec uses a unique group (`autosploit-projector-replay-<rand>`) to prove `findings`/`cost`/`audit_log` rebuild after truncate.

## 8. D-b — Kafka Connect S3 sink

**`test/s3-sink.spec.ts`** (dedicated, heavy — isolated from the live-path spec):

- Testcontainers: `minio/minio` (server + one bucket) and `confluentinc/cp-kafka-connect` on a shared `Network` with Redpanda (`@testcontainers/redpanda`), so Connect reaches the broker.
- Configure via Connect REST API `PUT /connectors/autosploit-s3-sink/config`:
  - `connector.class=io.confluent.connect.s3.S3SinkConnector`, `topics=<kafkaTopic>`, `key.converter`/`value.converter=org.apache.kafka.connect.json.JsonConverter` with `schemas.enable=false` (raw JSON archive), `format.class=...s3.format.json.JsonFormat`, `s3.bucket.name`/`s3.endpoint`/`s3.region=us-east-1`/creds → MinIO, small `flush.size` + short rotate interval so objects appear promptly.
- Produce a known event via ingest → poll MinIO (`minio` client) for an object → GET and assert the event line landed. Generous timeouts; this spec is the flakiest, kept separate so D-a/D-b never wait on Connect.

## 9. Module wiring

**`telemetry.module.ts`**: imports `LifecycleModule` (for `IngestTokenService` + `LifecycleService`); controllers `[IngestController, SseController]`; providers: `IngestService`, `SseGateway`, `EventSchemaService`, `SchemaRegistryService`, kafka providers, `SseBridgeConsumer`, `ProjectorConsumer`, `AuditConsumer`, `TelemetryConsumerLifecycle`. No new exports.

Disabled-broker behavior: providers resolve to null/disabled when `KAFKA_BROKERS` unset → app still boots (pre-D slices unaffected, same as the `INGEST_TOKEN_SIGNING_KEY` precedent); ingest returns 503 when hit.

## 10. Tests

- **`test/telemetry.spec.ts`** — D-a gate (real Postgres + Redis + Redpanda + Vault; fake conductor or direct ingest POSTs):
  - POST a valid event with a real minted ingest token → 202; event arrives via SSE to a raw http subscriber in sub-second.
  - Bad token → 401; valid token on wrong `:id` → 403; schema-violating event (missing required key, bad `type`, non-object `data`) → 422; no produce happened.
  - SSE: fresh subscribe replays backlog; disconnect + reconnect with `Last-Event-ID` replays only missed frames.
- **`test/telemetry-durable.spec.ts`** — D-b gate: produce finding/cost/tool_call events → rows appear; truncate `findings`/`cost`/`audit_log` → replay via fresh group fromBeginning → tables rebuilt identically; audit contains every tool call; live SSE path untouched (no re-subscribe needed).
- **`test/s3-sink.spec.ts`** — as §8.
- **`test/migrations.spec.ts`** — expected tables += `audit_log`.
- **`test/lifecycle.spec.ts`** — unchanged (global fetch stub means the real route is never hit there).

## 11. Sequencing

1. `packages/contracts`: generator + `event-schema.ts` + drift spec; run `bun run generate`; typecheck.
2. control-plane deps + env vars (EnvService + `.env.example`).
3. telemetry schema (`source_id`, `audit_log`) + `db:generate` migration + migrations.spec update.
4. Kafka providers + SchemaRegistryService + EventSchemaService.
5. Ingest guard + service + controller (D-a write end).
6. SSE bridge consumer + Redis last-mile.
7. SSE gateway + controller (D-a read end).
8. `telemetry.spec.ts` — D-a gate green.
9. Projector + Audit consumers.
10. `telemetry-durable.spec.ts` — D-b gate green.
11. `s3-sink.spec.ts` — Connect + MinIO green.
12. Full `build` / `typecheck` / `lint` / `test` pass.

## Risks

- **Connect in CI is heavy/flaky** — dedicated spec, shared network, small flush/rotate, generous timeouts; never blocks the live-path gate.
- **Redpanda JSON registry** — registration via REST is supported; we do not rely on broker-side JSON produce rejection (decision 2).
- **SSE on Fastify** — raw `reply.hijack()` stream avoids `@Sse()` adapter quirks; verified by a real http streaming assertion in the spec.
- **Kafka rebalance latency in tests** — single consumer per group; `waitFor` polling pattern (already used in lifecycle.spec) absorbs join latency.
