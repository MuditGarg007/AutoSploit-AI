# AutoSploit-AI — VPS offload & simplification plan

Status: **planned, nothing implemented yet.** Captured 2026-10-18 so the session
can be cleared. This is the authoritative to-do + rationale for lightening the
single Contabo VPS (`root@169.58.86.230`). All free-tier facts below were
web-verified on 2026-10-18 — re-check vendor pages before relying on exact
numbers, since free tiers change.

## Why

Everything runs on one Contabo box: a single-node `kind` cluster plus a
host-level Caddy reverse proxy. The persistent dependency pods share that one
node's RAM/CPU, and the real contention is engagement bursts (Kaniko build pod +
harness + target per run). Redpanda alone eats ~half the persistent footprint.
Goal: move stateful/heavy deps to free managed services, free ~1.75 GiB of RAM
for engagement bursts, and delete whole failure-mode classes (Redis/Kafka
missing-dependency hangs).

## What runs on the VPS today

Host (systemd / docker):
- **Caddy** — TLS termination (Let's Encrypt) + reverse proxy to NodePort 30080.
  Config at `/etc/caddy/Caddyfile` (mirrored in `deploy/vps/Caddyfile`).
- **Docker daemon** — runs the kind node and on-box image builds (no GHCR push creds).
- **kind** — single-node cluster `autosploit-hardening`.

Inside kind, `control-plane` namespace, persistent pods (limits):

| Component     | Image                              | Mem limit | Role                                         |
|---------------|------------------------------------|-----------|----------------------------------------------|
| redpanda      | redpanda v24.1.11                  | 1536Mi    | Kafka — findings ingest (+ schema registry)  |
| postgres      | postgres:16-alpine                 | 512Mi     | control-plane DB                             |
| control-plane | ghcr fat image                     | 512Mi     | NestJS API + in-process conductor + registry-mapper DaemonSet |
| redis         | redis:7-alpine                     | 256Mi     | BullMQ queue                                 |
| vault         | hashicorp/vault:1.17 (**dev mode**)| 256Mi     | GitHub-token **Transit** engine (encrypt/decrypt only) |

Manifests: `deploy/vps/deps-{redpanda,postgres,redis,vault}.yaml`.
Helm values wiring these: `deploy/helm/control-plane/values.yaml` (`external.*`).

Referenced but **NOT deployed**: MinIO. `values.yaml` points
`s3Endpoint: http://minio:9000` at nothing, so report upload to S3 is currently
dead. Fixed for free by the R2 move below.

Per-engagement (ephemeral, spun during runs, the real CPU spikes): engagement
namespace with harness pod, target pod, Kaniko build pod, in-cluster registry.

Frontend is already on Vercel — not on the VPS.

## Decisions (what we're doing)

### 1. Kafka → Aiven free Kafka  ✅ DO
- Free plan: 5 topics × 2 partitions, 250 KiB/s combined produce+consume, 3-day
  retention, **Schema Registry + REST Proxy included**, no credit card, no time limit.
- Our findings ingest is one low-volume topic → well within limits.
- **Biggest single RAM win** (removes the 1.5Gi Redpanda pod).
- Caveat — **idle power-off**: free services power off on no activity (Aiven
  notifies first). Our ingest fails closed (see the Kafka missing-dep failure
  class), so an engagement started against a cold broker could drop findings.
  - Mitigation: **5-min keep-alive** via an external free cron (cron-job.org /
    UptimeRobot) hitting the REST Proxy `GET /topics`. Keep it off the VPS so it
    survives VPS downtime. Add produce-side retry/backoff as a belt-and-braces.
  - Keep-alive is safe here because the free tier's only gate is *activity* —
    there is no documented compute-hour/runtime cap.
- Wiring: repoint `external.kafkaBrokers` and `external.schemaRegistryUrl` in
  `values.yaml` at the Aiven endpoints; move credentials into
  `control-plane-secrets`. Delete `deploy/vps/deps-redpanda.yaml` once live.

### 2. Reports / object storage → Cloudflare R2  ✅ DO
- Free: 10 GB storage, 1M Class A (write/list) ops, 10M Class B (read) ops,
  **zero egress**, deletes free, no 12-month expiry.
- Reports are small + infrequent → far under limits. Also fixes the dead MinIO pointer.
- R2 is S3-compatible: set `s3Endpoint` to the account R2 endpoint, add
  access-key/secret to `control-plane-secrets`, use path-style addressing.

### 3. Vault → stays on VPS  ❌ DO NOT OFFLOAD
- We use the **Transit engine** (encrypt/decrypt GitHub tokens; key never leaves
  Vault). Confirmed in `control-plane/src/domains/identity/vault/vault.service.ts`
  and `deploy/vault/transit-github-tokens.hcl`.
- **HCP Vault Secrets free tier is gone** (sunset mid-2025, full shutdown
  2026-07-01) **and never supported Transit** (static KV only). HCP Vault
  Dedicated has Transit but is ~$1k/mo. Free Transit exists only in self-hosted
  Vault Community Edition (now BSL-licensed).
- Vault is the smallest pod (256Mi) and is the security boundary → worst
  risk/reward to move. **Leave it on the VPS.**
- One real improvement to make: flip it from **dev mode** to a real/persisted
  config so a pod restart doesn't lose the key material.
- Future option if it ever must leave the box: app-level envelope encryption
  (libsodium/age with a data key in a k8s Secret), or cloud KMS (AWS/GCP) as a
  managed Transit-equivalent — cheap (~$1/key/month), not free. Not worth it now.

### 4. Redis / BullMQ → Aiven free Valkey  ✅ DO (vendor chosen: Aiven, not Upstash)
- Redis is only 256Mi, so this is a **reliability** play, not a RAM play — it
  kills the "engagements hang when Redis vanishes" failure class and lets the
  queue survive a node wipe.
- **Why Aiven, not Upstash:** Upstash free is command-metered (500K commands/mo,
  then $0.20/100K). BullMQ's worker loop (blocking pops, delayed-set polling,
  stalled-job watchdog) runs ~1 cmd/sec even idle ≈ 2.6M/mo → blows 500K in
  ~5 days. Aiven free Valkey (1 GB, metered by **size not commands**) is the
  right fit and needs no keep-alive trick for command budget.
- Caveat — same Aiven **idle power-off** applies. A BullMQ worker that stays
  connected generates continuous activity, so an always-on worker keeps it warm
  naturally; if workers can be fully idle for long stretches, add a light
  keep-alive as in #1.
- Wiring: repoint `external.redisUrl` in `values.yaml` at the Aiven Valkey
  endpoint (TLS), creds into `control-plane-secrets`. BullMQ needs
  `maxRetriesPerRequest: null` and a TLS connection. Delete
  `deploy/vps/deps-redis.yaml` once live.

### 5. Postgres → Neon  ✅ DO (decided 2026-10-18)
- Frees 512Mi + removes stateful disk from the VPS.
- Known risk, accepted: an earlier in-repo measurement (capacity-cpu-handoff)
  found per-query latency on the conductor/worker path hurt when Postgres was
  remote; that note said "never offload to Neon." We are overriding it — re-watch
  the conductor/worker path after the move and roll back if latency regresses.
- Neon free specifics: 100 CU-hours/month per project; autosuspend after 5 min
  idle, **not disableable** on Free; autoscale up to 2 CU; 0.5 GB storage.
- **Do NOT use a keep-alive ping on Neon.** Pinging keeps compute awake 24/7,
  which burns the 100 CU-hr budget (~0.25 CU floor × 730h ≈ 182 CU-hr) and
  Neon hard-suspends until the next billing period — strictly worse than a cold
  start. Neon gates on a *compute-hour budget*, not activity, so keep-alive
  backfires (unlike Aiven in #1/#4).
- Instead: rely on organic API traffic to keep it warm within budget, and accept
  ~0.5s cold-start on the first query after true idle.
- Wiring: repoint `external.postgresUrl` in `values.yaml` at the Neon connection
  string (sslmode=require), creds into `control-plane-secrets`. The migrations
  Job (`migrations.enabled`) must run against Neon before first boot. Delete
  `deploy/vps/deps-postgres.yaml` once a live engagement is proven green.

## Keep-alive rule of thumb (important distinction)

- **Aiven** free services gate on *activity* → a 5-min keep-alive ping keeps them
  on with no budget penalty. Use it for Kafka (#1), and for Valkey (#4) if
  workers can be fully idle.
- **Neon** free gates on a *compute-hour budget* → a keep-alive ping drains the
  budget and triggers a hard suspend. **Never ping Neon to keep it awake.**

## Net effect if we do #1, #2, #4, #5 (and leave #3)

- RAM freed on the VPS: Redpanda −1536Mi + Redis −256Mi + Postgres −512Mi
  ≈ **~2.3 GiB**, handed back to engagement bursts (the actual bottleneck).
- Deleted failure classes: Kafka missing-dep (ingest 503s), Redis missing-dep
  (engagements hang at "starting").
- Reports actually work (R2 replaces the never-deployed MinIO pointer).
- Remaining persistent pods on VPS: control-plane, vault.

## Implementation order (suggested)

1. **#1 Aiven Kafka** — highest RAM win. Provision, wire creds + `values.yaml`,
   set up the external REST-Proxy keep-alive cron, run an engagement to confirm
   findings land, then delete `deps-redpanda.yaml`.
2. **#4 Aiven Valkey** — provision, wire `redisUrl` + TLS, confirm BullMQ queue
   works end to end, then delete `deps-redis.yaml`.
3. **#2 R2** — create bucket + token, wire `s3Endpoint`/creds, confirm a report uploads.
4. **#5 Neon Postgres** — provision, wire `postgresUrl` + sslmode, run the
   migrations Job against Neon, confirm a live engagement, watch conductor/worker
   latency, then delete `deps-postgres.yaml`.
5. **#3 Vault** — flip dev-mode → persisted config (stays on VPS).

Each migration: provision managed service → put creds in `control-plane-secrets`
→ repoint the matching `external.*` value in
`deploy/helm/control-plane/values.yaml` → Helm rev bump → verify a live
engagement → only then delete the corresponding `deploy/vps/deps-*.yaml` so
there's a clean rollback until it's proven.

## Pointers

- Helm values / `external.*` wiring: `deploy/helm/control-plane/values.yaml`
- Dep manifests to retire: `deploy/vps/deps-{redpanda,redis,postgres}.yaml`
- Vault Transit usage: `control-plane/src/domains/identity/vault/vault.service.ts`,
  `deploy/vault/transit-github-tokens.hcl`
- Secrets land in the `control-plane-secrets` k8s Secret
- Related prior notes: `docs/capacity-cpu-handoff.md` (the Neon-latency warning)
