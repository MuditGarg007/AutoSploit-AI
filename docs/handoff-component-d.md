# Handoff — Component D (Telemetry, P4) implementation

Session continuation notes for `docs/component-d-telemetry.md` (the plan). Written
mid-implementation; everything below is the current state on `main`.

**2026-08-20 session update:** Component D is **COMPLETE and fully green**. The
final gate (s3-sink spec) passed after the `store.url` fix — see
`docs/issue-s3-sink-minio-endpoint.md` (marked resolved). A follow-up config
change serializes the heavy container specs (see "All gates green" below).

## Status summary

| Gate | Spec | Status |
|------|------|--------|
| Contract border | `packages/contracts/test/drift.spec.ts` (2 tests) | ✅ green |
| Migration | `control-plane/test/migrations.spec.ts` | ✅ green (incl. `audit_log`) |
| D-a live path | `control-plane/test/telemetry.spec.ts` (2 tests) | ✅ green |
| D-b durable | `control-plane/test/telemetry-durable.spec.ts` (1 test) | ✅ green |
| D-b S3 sink | `control-plane/test/s3-sink.spec.ts` (1 test) | ✅ green — `store.url` fix verified |
| Health regression | `control-plane/test/health.spec.ts` | ✅ green |
| **Full suite** | all 9 test files (30 tests) | ✅ green (serial) |
| Typecheck / lint (control-plane + contracts) | — | ✅ green |
| Build (nest build) | — | ✅ green |

## All gates green (2026-08-20)

- `store.url` (was `s3.endpoint`) applied + verified: connector RUNNING, event
  archived to `autosploit-reports/`, spec green (84.6s standalone).
- **Follow-up fix:** `vitest.config.ts` sets `fileParallelism: false`. Running
  all 9 container specs in parallel starved the `beforeAll` hooks (10s default)
  and the Connect wait (60s) — identity/repos/s3-sink failed only when run
  together. Serial: **9 files, 30 tests, all green** in ~4 min.
- Full pass re-verified: `typecheck`, `lint`, `build`, and `test` all green in
  control-plane; `generate`, `typecheck`, `test` green in packages/contracts.

## The remaining failure: S3 sink connector hits real AWS instead of MinIO

**Full write-up:** `docs/issue-s3-sink-minio-endpoint.md`.

**Symptom:** connector created (201), task starts, S3 client built, then:

```
AmazonS3Exception: The AWS Access Key Id you provided does not exist in our
records. (403 InvalidAccessKeyId) ... at S3Storage.bucketExists(S3Storage.java:186)
```

**Root cause:** the connector config uses `s3.endpoint: http://minio:9000`.
That property is **silently ignored** by kafka-connect-s3 10.5.8 — the
endpoint property is **`store.url`**. With `s3.endpoint` ignored, the S3 client
defaults to real AWS and rejects the fake `minioadmin` key.

**Fix (next session):** in `test/s3-sink.spec.ts`, replace `'s3.endpoint'` with
`'store.url'` (value stays `http://minio:9000`). Everything else in the
connector config stays. Then re-run the spec.

**Evidence:** worker-log config dump shows `store.url = null` and no
`s3.endpoint` accepted; bytecode inspection of `StorageCommonConfig.class`
(`store.url`) and `S3Storage.class` (`withEndpointConfiguration`) confirms it.

## What was fixed this session (root causes found + verified via logs)

1. **Redpanda died at startup — `redpanda.rpc_server missing`.** The hand-rolled
   `GenericContainer` used a static yaml without `rpc_server` and a raw
   `redpanda start` command. Fixed by mirroring the stock `@testcontainers/redpanda`
   bootstrap: a `RedpandaDualListenerContainer extends GenericContainer`
   subclass in the spec that (a) swaps the wait strategy in
   `beforeContainerCreated()` to wait for the wrapper script banner
   "Waiting for script...", (b) in `containerStarted()` copies
   `/testcontainers_start.sh` (mode 0o777, `rpk redpanda start --mode
   dev-container --smp=1 --memory=1G`) + a dual-listener `/etc/redpanda/redpanda.yaml`
   with the real mapped host port for the `external` listener and `redpanda:9093`
   for the `internal` listener, and (c) the script prints
   "Successfully started Redpanda!" so the stock log-message wait strategy
   resolves. This sidesteps the v10 `containerStarted()`-after-wait ordering.
2. **Connect worker never became ready; PUT → `500 Request timed out`.**
   Connect's internal topics default to `replication.factor=3`; single-node
   Redpanda can't create them. Added
   `CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR=1` /
   `CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR=1` /
   `CONNECT_STATUS_STORAGE_REPLICATION_FACTOR=1`. (After this, Connect's
   `connect-configs` etc. were created with RF 1 and the PUT returned 201.)
3. **Login failed: `no handler for route "transit/encrypt/github-tokens"`.**
   The spec started Vault but never provisioned the transit mount/key, so the
   OAuth callback crashed and `login()` read a missing `location` header.
   Added the standard provisioning used by every other spec:
   `NodeVault({...})` → `mount({mount_point:'transit', type:'transit'})` →
   `transitCreateKey({name:'github-tokens'})`.
4. **`withEnv(...)` crashed — v10 API.** The spec must use testcontainers v10
   (`withEnvironment({...})`), not the v12 `withEnv` API. Converted MinIO and
   Connect env vars.

All of 1–4 are already in the spec file. Only the `store.url` fix (above)
remains.

## What's implemented and verified

### packages/contracts
- `scripts/generate.mjs` now also emits `src/event-schema.ts` (draft 2020-12) via
  `generateEventSchema(schema)`; `src/index.ts` re-exports `eventSchema`.
- Per-type `if/then` branches enforce the per-type `required` keys **inside `data`**
  (e.g. `phase` requires `data.stage`). `halt` gets no required data keys.
- `test/drift.spec.ts` regenerates + diffs both `index.ts` and `event-schema.ts`.
- Build output refreshed; run `bun run generate && bun run build` in
  `packages/contracts` after any contract.schema.json change.

### control-plane
- **Env** (`src/config/env.service.ts`): `kafkaBrokers` ('' = disabled),
  `schemaRegistryUrl`, `kafkaTopic` (default `autosploit.events`), `kafkaClientId`,
  `kafkaPartitions` (fixed 3), `s3Endpoint`/`s3Bucket`/`s3AccessKey`/`s3SecretKey`.
  `.env.example` filled with local defaults.
- **Deps added**: `kafkajs`, `ajv`, `ajv-formats`; dev `@testcontainers/redpanda`,
  `minio`; and workspace dep `@autosploit/contracts`.
- **Schema** (`telemetry.schema.ts`): `findings.source_id` + unique index on
  `(engagement_id, source_id)`; new `audit_log` table (INSERT-only). Migration
  `src/db/migrations/0002_dark_harpoon.sql` generated + verified.
- **Kafka infra** (`telemetry/kafka/`): `kafka.providers.ts` (tokens `KAFKA`,
  `KAFKA_PRODUCER`, `KAFKA_ADMIN`, all resolve null when broker unset),
  `kafka-bootstrap.ts` (connect producer + `createTopics`, 3 partitions),
  `schema-registry.service.ts` (idempotent REST register of `eventSchema` as
  `<topic>-value`, log-only on failure), `event-schema.service.ts` (ajv 2020-12
  compile + formats), `telemetry-consumer.lifecycle.ts` (disconnect all consumers
  + producer + admin on shutdown).
- **RedisModule** (new, `src/redis/redis.module.ts`): `REDIS` token, `lazyConnect`,
  swallows connection errors so the app boots without Redis, and **`disconnect()`
  (not `quit()`) on shutdown** — this fixed the app.close() hang caused by the
  gateway's `XREAD BLOCK` holding the shared client.
- **Ingest (D-a write)**: `ingest/ingest-token.guard.ts` (401 invalid/missing,
  403 mis-scoped), `ingest/ingest.service.ts` (ajv validate → 422, produce keyed
  by engagement_id → 202; 503 when broker disabled), `ingest/ingest.controller.ts`
  (`@HttpCode(202)` + `@UseGuards(IngestTokenGuard)`).
- **SSE (D-a read)**: `consumers/sse-bridge.consumer.ts` (`XADD events:{id} MAXLEN
  ~ 1000`), `sse/sse.gateway.ts` (XRANGE replay incl. exclusive `(<cursor>` for
  Last-Event-ID; XREAD BLOCK 5000 live tail; keep-alive ping; breaks cleanly on
  abort/closed connection), `sse/sse.controller.ts` (SessionGuard +
  `LifecycleService.assertOwned` + `reply.hijack()` raw SSE + Last-Event-ID).
- **D-b consumers**: `consumers/projector.consumer.ts` (upsert findings by
  `(engagement_id, source_id)`, append cost rows with `usd_micros =
  round(usd*1e6)`), `consumers/audit.consumer.ts` (INSERT-only `tool_call` /
  `tool_result`). Both `handle()` methods are **public** so the replay test drives
  the exact production SQL from a fresh group.
- **Module wiring**: `telemetry.module.ts` imports LifecycleModule + RedisModule,
  registers everything; `app.module.ts` adds RedisModule. No new exports.

## Test evidence (behavior captured in specs)

- `telemetry.spec.ts`: 202 on valid event; 401 bad token; 403 token on other `:id`;
  422 missing required key / bad type / non-object data; SSE frame arrives live
  (asserted sub-second-ish, 10s CI-tolerant); fresh subscribe replays backlog;
  reconnect with `Last-Event-ID` replays only missed frames.
- `telemetry-durable.spec.ts`: finding upserts land 2 rows; cost row has correct
  `usd_micros`; audit has both tool events; **TRUNCATE → fresh group
  `autosploit-projector-replay-<rand>` fromBeginning → tables rebuilt identically**.

## The failing piece: test/s3-sink.spec.ts (current blocker)

**Goal (per plan §8):** Kafka Connect `S3SinkConnector` on a shared Docker network
with Redpanda + MinIO; produce via the real ingest path; poll MinIO for the archived
object and assert the event line.

**Current failure:** the S3 sink task starts but dies on its bucket-existence
check with `InvalidAccessKeyId` (403) — the connector ignored `s3.endpoint` and
hit real AWS. Full diagnosis + the `store.url` fix:
**`docs/issue-s3-sink-minio-endpoint.md`**.

**Where the old Redpanda startup problem went:** that root cause is FIXED. The
hand-rolled container now boots via a `RedpandaDualListenerContainer`
`GenericContainer` subclass (stock-module bootstrap pattern + dual listener) —
see "What was fixed this session" at the top of this doc. The infra (Redpanda,
MinIO, Connect + S3 plugin) all comes up and the connector is created; only the
endpoint config bug remains.

**Other notes on that spec (still true):**
- Images: `redpandadata/redpanda:latest` (NOT `redpanda/redpanda` — 404 on Hub),
  `minio/minio:latest`, `confluentinc/cp-kafka-connect:7.6.0`.
- Connect base image does NOT bundle the S3 sink connector → command runs
  `confluent-hub install --no-prompt confluentinc/kafka-connect-s3:10.5.8 && /etc/confluent/docker/run`.
  This may take a while on first pull.
- MinIO bucket must be created before Connect writes (`mc.makeBucket(...)` is in
  the spec). Connector config uses `store.url: http://minio:9000` (NOT
  `s3.endpoint` — that's the bug), `s3.path.style.access: true`, `flush.size: 1`,
  `rotate.interval.ms: 1000`, `topics.dir: autosploit-events`, JsonConverter with
  schemas disabled.
- The spec boots the full app (Postgres/Vault/Redis + GitHub fetch stub) so the
  event is produced through the REAL ingest path to the same broker Connect reads.

## Gotchas learned (do not rediscover)

1. **Nest DI needs explicit `@Inject()`** in this codebase — type-based constructor
   injection silently leaves the param `undefined` (the controller 500 bug). All
   telemetry constructors now use `@Inject`. Mirror `lifecycle.controller.ts`.
2. **ajv under NodeNext + bun's `.bun` layout**: `import Ajv from 'ajv'` binds to
   the module namespace (not constructable). Use the workaround in
   `event-schema.service.ts`: `import { Ajv } from 'ajv'` for the base, and for the
   2020-12 entry `import Ajv2020Ns from 'ajv/dist/2020.js'` then
   `(Ajv2020Ns as unknown as { default: unknown }).default`. `ajv-formats` default
   import needs the same cast (`formatsPlugin as unknown as (ajv) => void`).
3. **Drizzle `pgTable` extraConfig** returns a **Record**, not an array:
   `(t) => ({ name: uniqueIndex('name').on(...) })`.
4. **SSE client test helper** must `controller.abort()` (not `reader.cancel()`) to
   actually close the socket so the server's stream loop unwinds; otherwise
   `app.close()` hangs on the open stream.
5. **Redis shutdown is `disconnect()`**, never `quit()`, while a gateway `XREAD
   BLOCK` may be pending.
6. `@testcontainers/redpanda@12.1.0` drags in `testcontainers@12` while the project
   uses `testcontainers@10` — two versions coexist. The telemetry specs use the
   redpanda module standalone (fine); the s3 spec must stick to v10 imports
   (`Network`, `GenericContainer`, `Wait`) and a hand-rolled redpanda.
7. Redpanda `CreateTopics` + `Metadata` "no leader" errors during bootstrap are
   transient noise — the topic eventually exists and consumers join (~3-4s).
8. `KAFKAJS_NO_PARTITIONER_WARNING=1` silences the kafkajs v2 partitioner warning
   in test output.
9. Specs need real Vault (transit mount + `github-tokens` key created via
   node-vault), Postgres (migrations applied), Redis, and Redpanda — same pattern
   as `test/lifecycle.spec.ts`. A `realFetch` pass-through is required in the
   GitHub fetch stub so Schema Registry registration hits the real container.
10. **The S3 sink connector silently ignores unknown config keys.** `s3.endpoint`
    is NOT a property — the S3-compatible endpoint goes in **`store.url`**
    (verified via `StorageCommonConfig.class` / `S3Storage.class` bytecode). Always
    cross-check the `S3SinkConnectorConfig values:` dump in the worker log to see
    what was actually accepted.
11. **Connect on a single-node Redpanda needs RF=1 internal topics** — without
    `CONNECT_{CONFIG,OFFSET,STATUS}_STORAGE_REPLICATION_FACTOR=1` the worker
    retries internal-topic creation for 60s and connector PUTs return
    `500 Request timed out`.
12. **testcontainers v10 vs v12 API mismatch:** `withEnv(...)` (v12) crashes on
    v10 — use `withEnvironment({...})`. The s3 spec must keep using v10 imports
    (`Network`, `GenericContainer`, `Wait`, `WaitStrategy`).
13. **v10 `containerStarted()` runs AFTER the wait strategy resolves**, so a
    hand-rolled bootstrap must swap the wait strategy in
    `beforeContainerCreated()` (wait for the wrapper script's banner first), copy
    the real script/config in `containerStarted()`, and have the script print the
    original success banner itself. See `RedpandaDualListenerContainer` in the spec.
14. **Redpanda without `--mode dev-container` requires an explicit
    `rpc_server`/`advertised_rpc_api` in `redpanda.yaml`** — the earlier hand-rolled
    config died with `redpanda.rpc_server missing`.

## Remaining work (next session)

1. **All gates are green.** Nothing blocks Component D. The `store.url` fix and
   the serial-spec config are applied and verified (see "All gates green").
2. Optional: note completion in `docs/control-plane.md` §12 Component D / the plan
   doc if the project tracks it that way. No commit has been made for this work.
3. `git status` will show the full set of new/modified files — review before any
   commit. Untracked: `telemetry.spec.ts`, `telemetry-durable.spec.ts`,
   `s3-sink.spec.ts`, `ingest-token.service.ts`, `queue/`, `ingest-relay.ts`,
   `kafka/`, `redis/`, `fixtures/`, plus migration 0002, the plan doc, and the new
   `docs/issue-s3-sink-minio-endpoint.md`.
