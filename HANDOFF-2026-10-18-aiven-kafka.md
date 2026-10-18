# Handoff — Aiven Kafka migration (optimizations.md #1) + GitHub-token-expiry fix

Date: 2026-10-18
Branch: `feat/aiven-kafka-migration` (pushed to origin, **unmerged**)
Head: `a6c09cc feat(telemetry): add Kafka SASL/SCRAM+TLS for managed broker (Aiven)`
Deployed: VPS `root@169.58.86.230`, kind cluster `autosploit-hardening`, namespace `autosploit-system`, Helm release `control-plane` **rev 30**, image `ghcr.io/muditgarg007/control-plane:a6c09cc`.

## What this was

`optimizations.md` item #1: move the findings-ingest Kafka topic off the in-cluster
Redpanda pod (the biggest persistent RAM consumer, 1536Mi) onto Aiven free managed
Kafka, to free RAM for engagement bursts and delete Redpanda as a VPS-local failure
mode. During live verification a second, pre-existing problem surfaced (the dashboard
showing mock data) and was diagnosed and unblocked; it is not caused by this migration.

## Part A — Kafka migration: DONE and live

### Code + Helm (committed on the branch)
- `control-plane/src/config/env.service.ts` — added `KAFKA_SASL_MECHANISM`,
  `KAFKA_USERNAME`, `KAFKA_PASSWORD`, `KAFKA_SSL_CA` (all empty-default = plaintext, so
  local dev and self-hosted Redpanda are unchanged). Made `kafkaPartitions` read
  `KAFKA_PARTITIONS` (was hardcoded 3; Aiven free caps a topic at 2 partitions).
- `control-plane/src/domains/telemetry/kafka/kafka.providers.ts` — extracted exported
  `buildKafkaConfig(env)`. It is the single connection builder reused by the producer,
  admin and all four consumer groups, so they inherit `ssl`/`sasl` with no per-consumer
  change. `ssl.ca` + `sasl` are added only when configured.
- `deploy/helm/control-plane/templates/app-deployment.yaml` — four `optional: true`
  `secretKeyRef` env entries for the Kafka creds (so the app still boots on a plaintext
  broker).
- `deploy/helm/control-plane/values.yaml` — `external.kafkaBrokers` and
  `external.schemaRegistryUrl` now default to empty (set per-deploy via `--set`).
- `control-plane/test/kafka-providers.spec.ts` — config-shape test (plaintext stays
  plaintext; SASL/TLS shape when configured).
- `docs/vps-aiven-kafka-migration.md` — the operational runbook (provision, secret,
  deploy, verify, retire). Note: the namespace in it was corrected to `autosploit-system`.

Auth model: SASL/SCRAM-SHA-256 over TLS. Schema Registry (Karapace) is unused — the
pipeline is plain JSON, `SCHEMA_REGISTRY_URL` stays empty.

### Local verification (before deploy)
- `cd control-plane && npm run build` — green.
- `npx vitest run test/kafka-providers.spec.ts test/env.spec.ts` — 10 passed.
- `helm template ... --set external.kafkaBrokers=... --set env.KAFKA_PARTITIONS=2` —
  renders `KAFKA_PARTITIONS=2`, the broker endpoint, and the four secret envs.

### Aiven provisioning (owner did this in the console)
- Free Kafka service, **SASL authentication enabled** (mTLS is Aiven's default; SASL
  must be turned on).
- Topic `autosploit.events`, **2 partitions**.
- SASL host:port: `autosploit-kafka-muditgarg-51da.i.aivencloud.com:26875`.
- Project CA cert downloaded; SASL user/password created.

### Deploy (done on the box)
1. `control-plane-secrets` patched (merge, keeps the existing 9 keys) with
   `KAFKA_SASL_MECHANISM=scram-sha-256`, `KAFKA_USERNAME`, `KAFKA_PASSWORD`,
   `KAFKA_SSL_CA` (CA PEM from file).
2. Box repo `/root/AutoSploit-AI` checked out `feat/aiven-kafka-migration`.
3. Image built on box: `docker build -f control-plane/Dockerfile -t
   ghcr.io/muditgarg007/control-plane:a6c09cc .` then
   `kind load docker-image ghcr.io/muditgarg007/control-plane:a6c09cc --name autosploit-hardening`.
4. `helm upgrade control-plane deploy/helm/control-plane -n autosploit-system
   --reuse-values --set image.tag=a6c09cc --set
   external.kafkaBrokers=autosploit-kafka-muditgarg-51da.i.aivencloud.com:26875 --set
   env.KAFKA_PARTITIONS=2` → rev 30.

### Live verification (confirmed)
- New pod env: `KAFKA_BROKERS=...aivencloud.com:26875`, `KAFKA_SASL_MECHANISM=scram-sha-256`.
- Log: `Kafka producer connected (topic autosploit.events)` — SASL/TLS handshake to
  Aiven succeeded.
- All four consumer groups (`autosploit-audit`, `autosploit-projector`,
  `autosploit-quota-aggregator`, `autosploit-sse-bridge`) joined against the Aiven
  broker IPs on `:26875`. Zero `redpanda` references in the new pod.
- Benign log noise, all expected: `CreateTopics ... Topic creation errors` (topic
  pre-created, RF:1 request declined — log-only by design), a transient
  `GroupCoordinator not available` at startup, and the kafkajs v2 partitioner warning.

### Still open on Part A
1. **Full engagement end-to-end proof** — a real run whose findings land via Aiven
   (ingest not 503 → projector → Postgres → dashboard). This was blocked by Part B and
   is now unblocked. Not yet run.
2. **Retire Redpanda** — only after (1) is green:
   `kubectl -n autosploit-system delete -f deploy/vps/deps-redpanda.yaml` on the box,
   then `git rm deploy/vps/deps-redpanda.yaml` and commit. Redpanda
   (`deploy/vps/deps-redpanda.yaml`, pod still Running) is intentionally left up as the
   rollback until proven.
3. **Branch merge caveat** — `main`'s `values.yaml` now has `kafkaBrokers: ""`. The
   `deploy-vps` CI job fires on every `main` push (see the `auto-deploy-vps` note) and
   would deploy an empty broker unless it passes `--set external.kafkaBrokers=...` /
   `--set env.KAFKA_PARTITIONS=2`. Resolve how the CI job supplies the Aiven endpoint
   (e.g. a GH secret + `--set`, or a committed prod values file that is not in git
   today) **before** merging `feat/aiven-kafka-migration` to main.

### Rollback (Part A)
`helm upgrade control-plane deploy/helm/control-plane -n autosploit-system
--reuse-values --set external.kafkaBrokers=redpanda:9092 --set env.KAFKA_PARTITIONS=3`
(Redpanda is still running). The Kafka secret keys can stay; the plaintext path ignores
them.

## Part B — Dashboard "mock data" on New Engagement: diagnosed + unblocked (NOT fully fixed)

Reported as "deployment showing mock data when I click new engagement." This is a
pre-existing frontend/backend-bridge issue, independent of the Kafka change.

### Diagnosis
- `client/lib/api.ts` `listRepos` and `listEngagements` catch **every** error (including
  a 401) and silently return `MOCK_REPOS`/`MOCK_ENGAGEMENTS`. So "mock" means a backend
  call failed — not that `NEXT_PUBLIC_API_URL` is unset. (It is set on Vercel and baked
  into the live bundle; the backend is healthy: `/health` 200, `/engagements` 401 unauth,
  CORS preflight 204 with `access-control-allow-origin: https://autosploit.muditgarg.xyz`.
  The engagement **list** on the dashboard is real cached data.)
- The failing call is `GET /repos`, which returned `401` with body
  `{"message":"GitHub token rejected"}`. From
  `control-plane/src/domains/repos/repos.service.ts` `githubFetch` (maps a GitHub 401/403
  to `UnauthorizedException`). So a GitHub token IS linked and decrypts (Vault Transit is
  fine) — GitHub rejected it because the stored token had expired.
- Cause in code: `control-plane/src/domains/identity/identity.controller.ts:177`
  (`exchangeCode`) captures only GitHub's `access_token` and drops `refresh_token` /
  `expires_in`; `github_tokens` stores just the access token. The GitHub OAuth is a
  GitHub App (user tokens expire ~8h), so a token minted during an active session dies
  days later while cached engagement rows still render.

### Immediate unblock (done, verified)
Re-authenticated by navigating `https://api.autosploit.muditgarg.xyz/auth/github` (GitHub
session was already authorized, so it auto-redirected — no credential entry). This
re-exchanges the code and overwrites the `github_tokens` row with a fresh token.
Verified: `/repos` went 401 → **200 with 76 real repos**, and the New Engagement picker
now lists the user's real repos (`MuditGarg007/redis`, `offplanwise/frontend`,
`MuditGarg007/AutoSploit-AI`, ...), not mock.

### Durable fix (NOT done — code gap)
Capture and store the GitHub `refresh_token` + `expires_in` at `exchangeCode`, extend the
`github_tokens` schema (`control-plane/src/domains/identity/identity.schema.ts`) to hold
them, and refresh the GitHub token before use in `ReposService` / `IdentityService.
getGithubToken`. Until this lands, `/repos` dies roughly every 8 hours and the user must
re-login. Consider also making `client/lib/api.ts` surface a 401 on `/repos` as a
"re-connect GitHub" prompt instead of silently falling back to mock, so the failure is
visible.

## Quick reference

- VPS: `ssh root@169.58.86.230`; everything in namespace `autosploit-system`; on-box repo
  `/root/AutoSploit-AI`; images built on box + `kind load` (GHCR is private, no push creds).
- App pod label: `app.kubernetes.io/component=app`; deployment
  `control-plane-control-plane-app`.
- Backend public URL: `https://api.autosploit.muditgarg.xyz` (Caddy →
  `172.18.0.2:30080`, `deploy/vps/Caddyfile`). Frontend: Vercel,
  `https://autosploit.muditgarg.xyz`, env `NEXT_PUBLIC_API_URL` set + baked.
- No `curl` in the app pod — use `node -e "...fetch..."` for egress checks.
- Secret `control-plane-secrets` now holds 13 keys (9 original + 4 Kafka).

## Suggested next actions, in order

1. Run one live engagement from the dashboard on a deployable repo; tail the app pod and
   confirm findings land via Aiven (no ingest 503).
2. On green, retire Redpanda (delete manifest from cluster + `git rm` + commit).
3. Resolve the `main` deploy `--set` caveat, then merge `feat/aiven-kafka-migration`.
4. Implement the durable GitHub-token refresh (Part B durable fix).
5. Then proceed to the next `optimizations.md` items (#4 Valkey, #2 R2, #5 Neon).
