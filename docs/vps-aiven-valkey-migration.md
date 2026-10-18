# VPS migration runbook — Redis: in-cluster redis:7-alpine → Aiven free managed Valkey

> **Status: DONE + LIVE 2026-10-18** (helm rev 34). The plane runs against the Aiven
> Valkey endpoint; the in-cluster `redis` Deployment/Service are deleted and
> `deploy/vps/deps-redis.yaml` is removed. BullMQ Queue + Worker confirmed connected
> (`bull:engagements:meta` + `:stalled-check` present on Valkey); independence proven by
> scaling the old redis to 0 with no app impact. This runbook is kept for reference +
> rollback. Two corrections vs. the original plan are folded in below: **(1)** Aiven
> Valkey free presents a **Let's Encrypt** cert (chains to the public ISRG root), so
> `rediss://` verifies against system roots and **no `REDIS_TLS_CA` is needed**; the env
> is kept only for a future private-CA provider. **(2)** merge the Secret with
> `kubectl patch --type=merge`, **not** `create --dry-run | apply` — `apply` pruned
> `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (they were in the secret's stale
> `last-applied-configuration`); the annotation has since been stripped.

Moves BullMQ's dispatch queue + the telemetry SSE/quota cache off the in-cluster
`redis:7-alpine` pod onto Aiven's free managed Valkey. Redis is only `256Mi`, so this is a
**reliability** move, not a RAM move: it lets the queue survive a node wipe and kills the
"engagements hang at *starting* when Redis vanishes" failure class (`redis-missing-dep-gap`).

This is `optimizations.md` item #4. The code + Helm plumbing is already landed (TLS + auth
overlay). This runbook is the operational half: provision Aiven, load the credentials,
deploy, verify, then retire the in-cluster pod. It is ordered so the old `redis` pod stays
running until Valkey is proven green — a one-flag rollback the whole way.

## Auth model

Aiven Valkey requires TLS plus authentication. The endpoint host:port lives in `REDIS_URL`
using the **`rediss://`** scheme (TLS). The password — plus an optional username — is
injected from the `control-plane-secrets` Secret as `REDIS_PASSWORD` (and `REDIS_USERNAME`;
`default` is implicit so it is normally omitted). Each is `optional: true` so the app still
boots on the plaintext in-cluster redis. When all creds are unset,
`buildRedisConnectionOptions` returns an empty overlay and the client stays plaintext, so
local dev and any leftover `redis:7-alpine` keep working unchanged.

**No CA needed for Aiven.** Aiven Valkey free presents a **Let's Encrypt** server cert that
chains to the public ISRG root, so `rediss://` verifies against Node's system trust store
with no `REDIS_TLS_CA`. The `REDIS_TLS_CA` env (→ `tls.ca`, `rejectUnauthorized: true`) is
kept only for a future provider that uses a private CA.

`REDIS_PASSWORD` present → authenticated; `REDIS_TLS_CA` present → TLS verification pinned
to Aiven's private CA (`rejectUnauthorized: true`). Auth/TLS turn on by credential
presence, not a flag — same gating shape as the Kafka migration (#1).

Unlike `kafkaBrokers`, `REDIS_URL` must stay non-empty: an empty URL leaves BullMQ with no
connection and stalls the worker. So the local default `redis://redis:6379` stays in
`values.yaml`; prod overrides it per-deploy via `--set`.

## Free-tier constraints

- **1 GB, metered by size, not commands.** Chosen over Upstash (command-metered: BullMQ's
  worker loop ≈ 1 cmd/sec idle ≈ 2.6M/mo, blows Upstash's 500K free budget in ~5 days).
- **Idle power-off.** Free Aiven services power off on no activity. The BullMQ worker holds
  a persistent connection, so the broker stays warm whenever the plane is up; add an
  external keep-alive only if the worker can be fully idle for long stretches (step 3).
- Aiven gates on *activity*, not a compute-hour budget, so keep-alive is safe here (unlike
  Neon — never ping that).

## Steps

### 1. Provision the Aiven Valkey service

1. Aiven console → create a **Valkey** service on the **free** plan. No card, no time limit.
2. From the service overview, note the **host:port** and the **password** (and username,
   usually `default`).
3. No CA download needed — the service cert is Let's Encrypt (public root). See the
   "No CA needed" note under Auth model.

### 2. Set up an external keep-alive (off the VPS) — only if the worker can idle

The BullMQ worker holds a persistent connection, so Valkey stays warm whenever the plane is
up. Only if engagements are rare enough that the worker can be idle for long stretches:

- Use a free external cron (cron-job.org / UptimeRobot), hosted **off the VPS** so it
  survives VPS downtime, opening a TCP connection to the Valkey port every ~5 minutes.

### 3. Load credentials into the Secret (on the VPS)

The `control-plane-secrets` Secret is created imperatively (there is no `kind: Secret` in
the repo). Add the password with a **strategic merge patch** — `kubectl patch --type=merge`
never prunes existing keys:

```sh
# Base64 is JSON-safe, so inline it into the merge patch.
PW=$(printf '%s' '<aiven-password>' | base64 -w0)
kubectl -n autosploit-system patch secret control-plane-secrets --type=merge \
  -p "{\"data\":{\"REDIS_PASSWORD\":\"$PW\"}}"
```

> **Do NOT use `kubectl create --dry-run | kubectl apply` here.** During this migration
> that pattern *pruned* `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`: they were present in the
> secret's `kubectl.kubernetes.io/last-applied-configuration` annotation, so `apply`
> computed them as removed when the applied config named only the new key. (Keys added by
> `create` — `KAFKA_*`, `VAULT_*`, etc. — survived because they were never in last-applied.)
> The annotation has since been stripped (`kubectl annotate secret control-plane-secrets
> kubectl.kubernetes.io/last-applied-configuration-`), but prefer `patch --type=merge`
> regardless. Confirm afterwards (expect 14 keys incl. `GITHUB_CLIENT_ID`,
> `GITHUB_CLIENT_SECRET`, `REDIS_PASSWORD`):
> `kubectl -n autosploit-system get secret control-plane-secrets -o json | python3 -c 'import sys,json;print(sorted(json.load(sys.stdin)["data"]))'`

### 4. Deploy

Helm rev bump, pointing Redis at the Aiven `rediss://` endpoint. Keep the old `redis` pod
running.

```sh
helm upgrade --install control-plane deploy/helm/control-plane \
  --namespace autosploit-system \
  --set external.redisUrl='rediss://<aiven-host>:<port>' \
  # ...plus the existing --set flags this deploy already carries
```

Use the box's existing build + `kind load` flow (GHCR stays private). The endpoint is
passed via `--set`, not committed to `values.yaml`.

### 5. Verify

1. Pod restarts cleanly; no Redis connection errors in the control-plane log.
2. Enqueue a real engagement. The BullMQ worker must pick it up end-to-end — it must **not**
   hang at `starting` (the `redis-missing-dep-gap` tell). Confirm the engagement advances
   through its state machine.
3. The shared SSE/quota client connects: the live SSE stream delivers events and the quota
   meter reads/writes (no `quotaFailOpen` fallback log spam).
4. Confirm independence from the in-cluster pod:
   `kubectl -n autosploit-system scale deploy/redis --replicas=0` and re-run; the queue and
   SSE still work.

### 6. Retire the in-cluster Redis

Only after step 5 is green:

```sh
kubectl delete -f deploy/vps/deps-redis.yaml
git rm deploy/vps/deps-redis.yaml   # and commit
```

Update `optimizations.md` item #4 to done, and the `redis-missing-dep-gap` memory note.

## Rollback

If the queue stalls or the TLS handshake fails at any point before step 6, point back at
the still-running in-cluster pod and redeploy:

```sh
helm upgrade control-plane deploy/helm/control-plane --reuse-values \
  --set external.redisUrl='redis://redis:6379'
```

The Valkey Secret keys can stay in place — unused, they are inert (the plaintext path
returns an empty overlay and ignores them).

## Files touched by the code half (already landed)

- `control-plane/src/config/env.service.ts` — `redisUsername`/`redisPassword`/`redisTlsCa`
  env vars (all default empty = plaintext).
- `control-plane/src/redis/redis-connection.ts` — `buildRedisConnectionOptions`, the single
  overlay reused by the shared client + both BullMQ sites.
- `control-plane/src/redis/redis.module.ts`,
  `control-plane/src/domains/lifecycle/queue/engagement-queue.ts`,
  `control-plane/src/domains/lifecycle/lifecycle.module.ts` — spread the overlay onto the
  connection; the two BullMQ sites also set `maxRetriesPerRequest: null`.
- `deploy/helm/control-plane/templates/app-deployment.yaml` — three `optional: true`
  `secretKeyRef` env entries for the Valkey creds.
- `deploy/helm/control-plane/values.yaml` — `external.redisUrl` documented (stays non-empty
  local default; set per-deploy for managed).
- `control-plane/test/redis-connection.spec.ts` — overlay-shape regression test.
