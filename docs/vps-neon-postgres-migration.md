# VPS migration runbook — Postgres: in-cluster postgres:16-alpine → Neon free managed Postgres

Moves the control-plane database off the in-cluster `postgres:16-alpine` pod onto Neon's
free managed Postgres. The in-cluster pod is `512Mi` with **no PVC** — its data lives in the
pod writable layer and is already lost on any node rebuild. So this frees ~512Mi of RAM for
engagement bursts and removes stateful disk from the box.

This is `optimizations.md` item #5. The code + Helm plumbing is already landed (a secret-backed
`DATABASE_URL` behind the `external.databaseUrlFromSecret` toggle). This runbook is the
operational half: provision Neon, load the connection string, deploy, verify, then retire the
in-cluster pod. It is ordered so the old `postgres` pod stays running until Neon is proven
green — a one-flag rollback the whole way.

> This overrides the earlier `docs/capacity-cpu-handoff.md` stance ("do not offload to Neon").
> Its egress-isolation objection is not a blocker here: there is no `NetworkPolicy` /
> `CiliumNetworkPolicy` on the `autosploit-system` namespace — default-deny is SEAM-1, scoped
> to per-engagement namespaces only, so the plane pod's egress is already open (same path Aiven
> Kafka/Valkey use). Its latency objection is the accepted known risk — watch the
> conductor/worker path at step 5 and roll back if it regresses.

## Data cutover: fresh start

No data is copied. The in-cluster DB is ephemeral (and wiped on node rebuild anyway); findings
are durable in R2. The migrate Job creates the full schema on an empty Neon DB. Consequence:
**all users re-auth via GitHub OAuth** and any in-flight engagement rows are dropped at cutover.
If history must survive a future move, `pg_dump | pg_restore` before cutover instead.

## Auth / TLS model

Neon requires TLS and uses a publicly-trusted CA (Let's Encrypt / ISRG), so no CA pinning is
needed — unlike the Kafka/Valkey migrations, which pin a private Aiven CA. Put `?sslmode=require`
in the connection string; `node-postgres` honors it with no code change to the two `pg.Pool`
sites (`control-plane/src/db/drizzle.module.ts`, `control-plane/src/db/migrate.ts`).

The Neon string carries a password inline, so — unlike the password-less in-cluster URL — it
must not sit in plaintext Helm values or `kubectl` output. The whole `DATABASE_URL` string
moves into `control-plane-secrets`. Setting `external.databaseUrlFromSecret=true` flips both the
app Deployment and the migrate Job from the plain `external.postgresUrl` value to a
`secretKeyRef` on the `DATABASE_URL` key. Toggle off (the default) keeps the plaintext
in-cluster URL, so dev/tests/local boot unchanged.

> Contingency: if this `pg` version ignores `sslmode` from the string and the migrate Job fails
> its TLS handshake, add `ssl: { rejectUnauthorized: false }` to both `new Pool(...)` sites
> (`drizzle.module.ts`, `migrate.ts`). Not part of the default change.

## Free-tier constraints

- **100 CU-hr/month, 0.5 GB storage, autoscale to 2 CU.** A low-traffic control DB is well
  within this.
- **Autosuspend after 5 min idle (not disableable on Free).** ~0.5s cold-start on the first
  query after true idle.
- **Never ping Neon to keep it warm.** Neon gates on a *compute-hour budget*, not activity
  (unlike Aiven). A keep-alive drains the 100 CU-hr budget (~0.25 CU floor × 730h ≈ 182 CU-hr)
  and triggers a hard suspend until the next billing period — strictly worse than a cold start.
  Rely on organic API traffic; accept the cold start.

## Steps

### 1. Provision the Neon project

1. Neon console → create a project (pick the region closest to the Contabo box to minimize the
   accepted latency).
2. Copy the **pooled** connection string from the dashboard, and append `?sslmode=require` if it
   is not already present.

### 2. Load the connection string into the Secret (on the VPS)

The `control-plane-secrets` Secret is created imperatively (there is no `kind: Secret` in the
repo). Merge the `DATABASE_URL` key in **without clobbering** existing keys by re-applying
through `kubectl apply`:

```sh
kubectl -n autosploit-system create secret generic control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://<user>:<pw>@<host>/<db>?sslmode=require' \
  --dry-run=client -o yaml | kubectl apply -f -
```

> Note: `create ... --dry-run=client | apply` patches only the key named here; the existing app
> secrets (`INGEST_TOKEN_SIGNING_KEY`, `JWT_*`, `GITHUB_*`, `VAULT_*`, `KAFKA_*`, `REDIS_*`,
> `OPENROUTER_API_KEY`) are preserved by `apply`'s merge. Confirm afterwards:
> `kubectl -n autosploit-system get secret control-plane-secrets -o jsonpath='{.data}' | tr ',' '\n'`
> should list `DATABASE_URL` alongside all the old keys.

### 3. Deploy

Helm rev bump, flipping `DATABASE_URL` to the secret. Keep the old `postgres` pod running.

```sh
helm upgrade --install control-plane deploy/helm/control-plane \
  --namespace autosploit-system --reuse-values \
  --set external.databaseUrlFromSecret=true
```

The `pre-install,pre-upgrade` migrate Job runs `node dist/db/migrate.js` against the empty Neon
DB **first**, creating the full schema (drizzle journal 0000–0005 and `__drizzle_migrations`)
before the app Deployment rolls out and serves a request. Use the box's existing build +
`kind load` flow (GHCR stays private).

### 4. Verify

1. The migrate Job completes (no TLS handshake error — proves `?sslmode=require` works; else the
   `ssl` contingency above). Confirm the schema landed:
   `psql "$NEON_URL" -c '\dt'` shows the tables and `__drizzle_migrations`.
2. Pod restarts cleanly; no Postgres connection errors in the control-plane log; GitHub OAuth
   callback succeeds (no `relation "users" does not exist`).
3. **Run one real engagement** end-to-end through the dashboard → `POST /engagements` → worker →
   conductor. Confirm it reaches a terminal state and an `engagement-*` namespace +
   `conductor.json` record appear. This exercises the conductor/worker DB path
   `capacity-cpu-handoff.md` warned about — **watch latency here** and roll back if it regresses.

### 5. Retire the in-cluster Postgres

Only after step 4 is green:

```sh
kubectl delete -f deploy/vps/deps-postgres.yaml
git rm deploy/vps/deps-postgres.yaml   # and commit
```

Confirm the RAM is reclaimed: `kubectl top pod -n autosploit-system` no longer lists `postgres`.
Update `optimizations.md` item #5 to done and the `vps-offload-plan` memory note.

## Rollback

If the migrate Job fails, the app can't connect, or the conductor/worker latency regresses at
any point before step 5, point back at the still-running in-cluster pod and redeploy:

```sh
helm upgrade control-plane deploy/helm/control-plane --reuse-values \
  --set external.databaseUrlFromSecret=false
```

The `DATABASE_URL` Secret key can stay in place — unused with the toggle off, it is inert. If
the in-cluster pod was already deleted, re-apply it first: `kubectl apply -f deploy/vps/deps-postgres.yaml`.

## Files touched by the code half (already landed)

- `deploy/helm/control-plane/templates/app-deployment.yaml` — `DATABASE_URL` sourced from the
  secret under the `databaseUrlFromSecret` toggle, else the plain value.
- `deploy/helm/control-plane/templates/migrate-job.yaml` — same toggle, so the pre-upgrade hook
  migrates the same DB the app connects to.
- `deploy/helm/control-plane/values.yaml` — `external.databaseUrlFromSecret: false` with the
  Neon / `sslmode` / never-ping notes.

No application code changed: `DATABASE_URL` is already the single connection source consumed by
`env.service.ts` and both `pg.Pool` sites, and TLS rides in the URL string.
