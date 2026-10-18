# VPS migration runbook — Kafka: self-hosted Redpanda → Aiven free managed Kafka

Moves the findings-ingest topic off the in-cluster Redpanda pod (the single biggest
persistent RAM consumer, `1536Mi`) onto Aiven's free managed Kafka. Frees ~1.5 GiB on the
VPS node for engagement bursts and removes Redpanda as a VPS-local failure mode.

This is `optimizations.md` item #1. The code + Helm plumbing is already landed (SASL/SCRAM
over TLS). This runbook is the operational half: provision Aiven, load the credentials,
deploy, verify, then retire Redpanda. It is ordered so Redpanda stays running until Aiven
is proven green — a one-flag rollback the whole way.

## Auth model

Aiven Kafka requires TLS plus authentication. We use **SASL/SCRAM-SHA-256** (username +
password + the project CA cert), which is the lightest secret plumbing. The control-plane
reads four env vars — `KAFKA_SASL_MECHANISM`, `KAFKA_USERNAME`, `KAFKA_PASSWORD`,
`KAFKA_SSL_CA` — all injected from the `control-plane-secrets` Secret (each `optional: true`
so the app still boots on a plaintext broker). When all four are unset the client stays
plaintext, so local dev and any leftover Redpanda keep working unchanged.

The Schema Registry (Karapace) is **not used** — the pipeline is plain JSON, so
`SCHEMA_REGISTRY_URL` stays empty.

## Free-tier constraints

- **2 partitions per topic max.** We deploy `KAFKA_PARTITIONS=2`. Ordering is preserved per
  `engagement_id` key regardless of partition count.
- **5 topics max.** We use one: `autosploit.events`.
- **3-day retention.** Fine — findings are projected into Postgres on consume; the topic is
  a transport, not the store of record.
- **Idle power-off.** Free services power off on no activity. Ingest fails closed (503), so
  a cold broker during an engagement would drop findings — see the keep-alive step.

## Steps

### 1. Provision the Aiven Kafka service

1. Aiven console → create a **Kafka** service on the **free** plan. No card, no time limit.
2. Service settings → **Authentication methods**: enable **SASL**. (Aiven defaults to mTLS
   only; SASL must be turned on explicitly.) This exposes a separate **SASL port** distinct
   from the mTLS port — that is the one we connect to.
3. From the service overview, note the **SASL connection host:port**.
4. Download the project **CA certificate** (`ca.pem`) — "CA Certificate" on the overview.

### 2. Create the topic and credentials

1. Topics → create `autosploit.events` with **2 partitions**, retention ≤ 3 days.
   Pre-creating it means the app's `createTopics` call (which requests replication-factor 1)
   is harmless if Aiven declines it — that call is log-only on failure.
2. Users/credentials → create or copy a SASL user. Record its **username** and **password**.

### 3. Set up an external keep-alive (off the VPS)

Free Aiven services power off when idle. The four control-plane consumer groups hold
persistent broker connections, so the broker stays warm whenever the plane is up; the
external ping is belt-and-braces for when the VPS itself is down.

- Use a free external cron (cron-job.org / UptimeRobot), hosted **off the VPS** so it
  survives VPS downtime, hitting the service every ~5 minutes.
- A lightweight TCP/connection check against the SASL port is enough. If you prefer an HTTP
  probe, enable Aiven's REST Proxy and poll `GET /topics`.
- The free tier gates on *activity*, not a compute-hour budget, so keep-alive is safe here
  (unlike Neon — never ping that).

### 4. Load credentials into the Secret (on the VPS)

The `control-plane-secrets` Secret is created imperatively (there is no `kind: Secret` in
the repo). Merge the four Kafka keys in **without clobbering** the existing keys by
re-applying the full set through `kubectl apply`:

```sh
# ca.pem is the file downloaded in step 1.4; run from where it sits.
kubectl -n autosploit-system create secret generic control-plane-secrets \
  --from-literal=KAFKA_SASL_MECHANISM=scram-sha-256 \
  --from-literal=KAFKA_USERNAME='<aiven-user>' \
  --from-literal=KAFKA_PASSWORD='<aiven-password>' \
  --from-file=KAFKA_SSL_CA=ca.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

> Note: `create ... --dry-run=client | apply` patches only the keys named here; the
> existing app secrets (`INGEST_TOKEN_SIGNING_KEY`, `JWT_*`, `GITHUB_*`, `VAULT_*`,
> `OPENROUTER_API_KEY`) are preserved by `apply`'s merge. Confirm afterwards:
> `kubectl -n autosploit-system get secret control-plane-secrets -o jsonpath='{.data}' | tr ',' '\n'`
> should list all keys, old and new.

### 5. Deploy

Helm rev bump, pointing the broker at Aiven and capping partitions. Keep Redpanda running.

```sh
helm upgrade --install control-plane deploy/helm/control-plane \
  --namespace autosploit-system \
  --set external.kafkaBrokers='<aiven-sasl-host>:<sasl-port>' \
  --set external.schemaRegistryUrl='' \
  --set env.KAFKA_PARTITIONS=2 \
  # ...plus the existing --set flags this deploy already carries
```

Use the box's existing build + `kind load` flow (GHCR stays private). The broker endpoint
is passed via `--set`, not committed to `values.yaml`.

### 6. Verify

1. Pod restarts cleanly; control-plane log shows
   `Kafka producer connected (topic autosploit.events)`
   (`control-plane/src/domains/telemetry/kafka/kafka-bootstrap.ts`). A TLS/SASL handshake
   failure shows here instead as `Kafka bootstrap skipped: ...`.
2. Run an engagement. The ingest endpoint must **not** return 503
   (`ingest.service.ts` throws `Ingest disabled (no broker configured)` only when the
   producer is null).
3. Findings land in the dashboard — the projector consumer writes them to Postgres.
4. Confirm independence from Redpanda: `kubectl -n autosploit-system scale deploy/redpanda
   --replicas=0` and re-run; findings still flow.

### 7. Retire Redpanda

Only after step 6 is green:

```sh
kubectl delete -f deploy/vps/deps-redpanda.yaml
git rm deploy/vps/deps-redpanda.yaml   # and commit
```

Update `optimizations.md` item #1 to done, and the `kafka-missing-dep-gap` memory note.

## Rollback

If ingest 503s or the handshake fails at any point before step 7, point back at the
still-running Redpanda and redeploy:

```sh
helm upgrade control-plane deploy/helm/control-plane --reuse-values \
  --set external.kafkaBrokers='redpanda:9092' \
  --set env.KAFKA_PARTITIONS=3
```

The Kafka Secret keys can stay in place — unused, they are inert (the plaintext broker
path ignores them).

## Files touched by the code half (already landed)

- `control-plane/src/config/env.service.ts` — Kafka SASL/TLS env vars; `kafkaPartitions`
  now reads `KAFKA_PARTITIONS` (was hardcoded 3).
- `control-plane/src/domains/telemetry/kafka/kafka.providers.ts` — `buildKafkaConfig` adds
  `ssl`/`sasl` when configured; the single builder feeds producer, admin and all consumers.
- `deploy/helm/control-plane/templates/app-deployment.yaml` — four `optional: true`
  `secretKeyRef` env entries for the Kafka creds.
- `deploy/helm/control-plane/values.yaml` — `external.kafkaBrokers`/`schemaRegistryUrl`
  default to empty (set per-deploy).
- `control-plane/test/kafka-providers.spec.ts` — config-shape regression test.
