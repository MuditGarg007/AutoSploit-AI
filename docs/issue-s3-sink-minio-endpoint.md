# Issue: s3-sink spec — S3 sink connector fails with `InvalidAccessKeyId` against MinIO

**Status:** ✅ RESOLVED — verified 2026-08-20 (spec green, event archived to MinIO)
**Gate:** Component D-b exit gate `control-plane/test/s3-sink.spec.ts`
**Doc refs:** `docs/component-d-telemetry.md` §8, `docs/handoff-component-d.md`

## Summary

The last failing gate for Component D is the Kafka Connect S3-sink spec. The
infra now boots (Redpanda dual-listener, MinIO, Connect + S3 plugin), the
connector is created (HTTP 201), the task starts, and the S3 client is built —
but the task immediately dies with:

```
org.apache.kafka.connect.errors.ConnectException: com.amazonaws.services.s3.model.AmazonS3Exception:
The AWS Access Key Id you provided does not exist in our records.
(Service: Amazon S3; Status Code: 403; Error Code: InvalidAccessKeyId; ...)
	at io.confluent.connect.s3.storage.S3Storage.bucketExists(S3Storage.java:186)
	at io.confluent.connect.s3.S3SinkTask.start(S3SinkTask.java:114)
```

The stack trace shows the failure is in `getBucketAcl` → `doesBucketExistV2`,
i.e. the bucket-existence check at task start.

## Root cause

The connector config in the spec uses **`s3.endpoint: http://minio:9000`**.
That property is **not accepted** by the S3 sink connector (v10.5.8). The
connector silently ignores unknown properties, so the S3 client is built with
the **default AWS endpoint** (`s3.us-east-1.amazonaws.com`) instead of MinIO.

The request goes to real AWS, which rejects the fake `minioadmin` access key
with `InvalidAccessKeyId` (403).

### Evidence

1. **Config dump** from the failing run (Connect worker log): the
   `S3SinkConnectorConfig values:` block shows `store.url = null` and there is
   **no `s3.endpoint` entry** anywhere in the accepted config. Unknown config
   keys are dropped without error.
2. **Bytecode inspection** of the installed connector jars:
   - `StorageCommonConfig.class` (kafka-connect-storage-common-11.2.5.jar)
     defines the URL config as **`store.url`**.
   - `S3Storage.class` (kafka-connect-s3-10.5.8.jar) builds the AWS client via
     `AmazonS3ClientBuilder.withEndpointConfiguration(...)` — the endpoint
     comes from the storage config URL (`store.url`), not a custom key.
   - `S3SinkConnectorConfig.class` only references "accelerated endpoint"
     (a different, S3-only option).

## The fix (applied and verified)

Replace `s3.endpoint` with **`store.url`** in the connector config — applied to
`control-plane/test/s3-sink.spec.ts` and **verified green** on 2026-08-20: the
connector reached RUNNING, the S3 task created
`autosploit-events/autosploit.events/partition=0/autosploit.events+0+0000000000.json`
in bucket `autosploit-reports`, committed offset 1, and the spec asserted the
event line (`F-001`, `archived finding`) landed. Full run: 84.6s, 1/1 passed.

```jsonc
// before (wrong — ignored by the connector):
"s3.endpoint": "http://minio:9000",

// after:
"store.url": "http://minio:9000",
```

Keep everything else (`s3.bucket.name`, `s3.region: us-east-1`,
`s3.path.style.access: true`, `aws.access.key.id` / `aws.secret.access.key`,
`flush.size: 1`, `rotate.interval.ms: 1000`).

### Related fixes already landed in this session

These are separate root causes that were found and fixed on the way here (all
verified against Connect logs):

| Symptom | Root cause | Fix |
|---|---|---|
| `redpanda.rpc_server missing` — hand-rolled Redpanda container died at startup | Config lacked `rpc_server`; raw `redpanda start` (no `--mode dev-container`) requires it | Mirrored the stock `@testcontainers/redpanda` bootstrap: wrapper script (`/testcontainers_start.sh`) + `--mode dev-container` + dual-listener `redpanda.yaml` copied in via a `GenericContainer` subclass's `containerStarted()` hook; wait on `Successfully started Redpanda!` printed by the script |
| Connect worker never became ready; connector PUT → `500 {"message":"Request timed out"}` | Connect defaults internal-topic replication factor to **3**, but Redpanda is single-node → `connect-configs`/`connect-offsets`/`connect-status` could not be created | Set `CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR=1`, `CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR=1`, `CONNECT_STATUS_STORAGE_REPLICATION_FACTOR=1` |
| Login callback failed (`no handler for route "transit/encrypt/github-tokens"`) → `login()` crashed on missing `location` header | The spec started Vault but never mounted the transit backend or created the `github-tokens` key | Added the same provisioning as every other spec: `NodeVault({...})` → `mount({mount_point:'transit', type:'transit'})` → `transitCreateKey({name:'github-tokens'})` |
| Spec used `withEnv(...)` — crashed with `TypeError` | The spec must use testcontainers **v10** (`testcontainers@10.28.0`), where the API is `withEnvironment({...})`, not `withEnv(...)` (v12 API) | Converted all `withEnv(...)` chains to `withEnvironment({...})` |

## How to verify

1. Apply the `store.url` fix in `control-plane/test/s3-sink.spec.ts`.
2. Run: `bunx vitest run test/s3-sink.spec.ts` (heavy — pulls the S3 plugin on
   first Connect start; give it several minutes).
3. Success looks like: connector `state: RUNNING`, a produced event (via the
   real ingest path) appears as an object under `autosploit-reports/`, and the
   object body contains the event line (`F-001`, `archived finding`).

## Gotchas worth recording

- The S3 sink connector **silently ignores unknown config properties** — always
  check the `S3SinkConnectorConfig values:` dump in the worker log to confirm a
  property was accepted.
- The plugin `.jar` inspection is the ground truth for property names
  (`kafka-connect-s3-10.5.8.jar` + `kafka-connect-storage-common-11.2.5.jar`).
- Connect's REST `PUT /connectors/{name}/config` blocks until the connector
  reaches RUNNING/FAILED (default `request.timeout.ms=40000` at the worker).
  A 500 "Request timed out" on PUT is a symptom of a connector that can't
  start, not a bug in the test.
