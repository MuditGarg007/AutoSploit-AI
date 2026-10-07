# GHCR control-plane image broken — root cause, fix, and remaining deploy — handoff

**Date:** 2026-10-07
**Branch (local):** `main` @ `3b42325` (fix applied in working tree, **not yet committed**)
**Box:** Contabo `root@169.58.86.230`, 4 vCPU / 8 GB, kind `autosploit-hardening`
**Predecessor:** `docs/vps-backend-deploy-handoff.md` (the deploy checklist). This handoff
covers the one thing that blocked step 7 of that checklist — the published GHCR image
does not boot — and the proven fix for it.

## TL;DR

- The published image `ghcr.io/muditgarg007/control-plane:latest` **crashes on boot**
  with `ERR_MODULE_NOT_FOUND: Cannot find package 'reflect-metadata'`. Both digests seen
  this session are broken (`edb83ae…`, then `c9c363…` from the latest successful release).
- **Root cause:** bun was bumped to **1.4.0** on `main` (commit `e63ebcc`, for the text
  `bun.lock`). bun ≥1.2 uses an **isolated install layout** — the root `node_modules`
  holds only the `.bun` content store, and each workspace's own `node_modules` holds the
  symlinks that resolve into it. `control-plane/Dockerfile` copies the root `node_modules`
  but **not** `/app/control-plane/node_modules`, so at runtime every top-level import
  (`reflect-metadata`, `@nestjs/*`, the `@autosploit/contracts` workspace link) is missing.
  It worked under the old bun 1.1.0 because that hoisted everything into the root
  `node_modules`.
- **Fix:** one `COPY` line in `control-plane/Dockerfile` to ship the workspace
  `node_modules`. Applied in the working tree, **boot-proven** locally (see Proof).
- **Live deploy is currently healthy** — it runs the locally-built `control-plane:h3-local`
  image (helm rev 4, a rollback to the pre-GHCR revision), `1/1 Running`. Nothing is down.
- **Remaining:** commit + release the fix so GHCR publishes a good image, then repoint the
  live deploy to the new digest and verify. The H3 red-team gate already passed GREEN on
  this box on 2026-10-06 and is unaffected by the image build.

## Current state on the box (verified this session)

| Thing | State |
|---|---|
| Virt / BTF / tools / gVisor | all present; preflight passes |
| Swap | 6 GB already configured |
| kind cluster `autosploit-hardening` | up ~16 h |
| Cilium | `OK` on the pinned `1.21.0-pre.2` (this kernel) |
| Namespaces | `autosploit-system`, `engagement-h3gate` (+ system) |
| Control plane | `control-plane-control-plane-app` **1/1 Running, 0 restarts**, image `control-plane:h3-local` (local, not GHCR) |
| Stateful deps | **Postgres only** (`postgres` Deployment + Service). No Redis/Vault/Redpanda/MinIO — env references them but readiness only needs the app's `/health` |
| Helm | release `control-plane`, **rev 4 = "Rollback to 2"** |
| `control-plane-secrets` | 7 keys present (`GITHUB_*`, `JWT_*`, `INGEST_TOKEN_SIGNING_KEY`, `VAULT_TRANSIT_KEY`) |

### How we got to rev 4

Session start resolved `:latest` → `edb83ae…` and repointed the chart to that digest
(`helm upgrade --reuse-values --set image.repository=ghcr.io/muditgarg007/control-plane
--set image.tag=latest@sha256:edb83ae…`). The new pod went **CrashLoopBackOff**
(`reflect-metadata` not found); the old `h3-local` pod kept serving the whole time (rollout
held, **no downtime**). A `helm rollback` restored the working revision → the current
rev 4. The GHCR image, not the deploy mechanics, is the problem.

## Root cause — the evidence chain

1. Pulled the published image and inspected it: root `/app/node_modules` contains only
   `.bin`, `.bun` (the content store) and a `turbo` symlink — **no** top-level package
   dirs. `node dist/main.js` fails at `reflect-metadata`.
2. A clean root-context build **on the box** (VPS checkout, branch `h3-contabo-seam1-chart-fixes`)
   booted fine — because that branch's Dockerfile still used `FROM oven/bun:1.1.0`, which
   hoists into the root `node_modules`.
3. `main`'s Dockerfile is `FROM oven/bun:1.4.0`; CI logs confirm `bun install v1.4.0`.
4. Built the `main` Dockerfile's **build stage** locally and inspected the layout under
   bun 1.4.0:
   - root `/app/node_modules/reflect-metadata` → **absent**
   - `/app/control-plane/node_modules/reflect-metadata` →
     `-> ../../node_modules/.bun/reflect-metadata@0.2.2/node_modules/reflect-metadata`
   - the workspace `node_modules` holds 32 such symlinks (`@nestjs`, `@fastify`,
     `@autosploit`, …) — the exact set `dist/main.js` imports.
5. The runtime stage never copies `/app/control-plane/node_modules`, so those symlinks
   (and thus the packages) are absent in the final image. Arch-independent and
   context-independent — a pure Dockerfile omission, so the multi-arch `--push` image is
   broken the same way the `--load` scan image is.

### Note on the stale-tag confusion

At session start `:latest` resolved to `edb83ae…` (from a **failed** release run that had
already pushed `latest` before a later step failed, 06:31 UTC). Later it resolved to
`c9c363…` from the most recent **successful** run (`37588429988`, HEAD `3b42325`,
07:37 UTC). **Both are broken** — the successful run's amd64 layers were served from
BuildKit's within-run cache off the same unfixed Dockerfile, so re-releasing without the
Dockerfile change republishes the same broken image. The fix below changes the Dockerfile,
which busts that cache and forces a real rebuild.

## The fix

`control-plane/Dockerfile`, runtime stage — one added `COPY` (with an explanatory comment):

```dockerfile
COPY --from=build --chown=autosploit:autosploit /app/node_modules ./node_modules
COPY --from=build --chown=autosploit:autosploit /app/packages ./packages
# bun >=1.2 uses an isolated install layout: the root node_modules holds only the
# .bun content store, while each workspace's node_modules holds the symlinks that
# resolve into it (e.g. control-plane/node_modules/reflect-metadata -> ../../node_modules/.bun/...).
# dist/main.js resolves its deps through control-plane/node_modules, so that dir must
# ship too — without it every top-level import (reflect-metadata, @nestjs/*, the
# @autosploit/contracts workspace link) fails with ERR_MODULE_NOT_FOUND at boot.
COPY --from=build --chown=autosploit:autosploit /app/control-plane/node_modules ./control-plane/node_modules
COPY --from=build --chown=autosploit:autosploit /app/control-plane/dist ./control-plane/dist
COPY --from=build --chown=autosploit:autosploit /app/control-plane/package.json ./control-plane/package.json
```

The workspace symlinks are relative and point back into the root `.bun` store, which is
already copied — so adding the workspace `node_modules` makes them resolve. The existing
`chmod -R a+rX /app` already covers the new dir.

### Proof (local, `linux/amd64`)

```
docker buildx build --platform linux/amd64 --load -t cp-fix:test -f control-plane/Dockerfile .
docker run --rm cp-fix:test
# => Error: Missing required env var: DATABASE_URL
```

Boot now reaches config validation (`Missing required env var: DATABASE_URL`) — i.e. all
module resolution succeeds. Before the fix the same run died at
`ERR_MODULE_NOT_FOUND: reflect-metadata`. The `DATABASE_URL` error is expected for a bare
`docker run` with no env; in-cluster the chart supplies it.

(One build attempt failed transiently on `IntegrityCheckFailed` downloading
`terser@5.50.0` — a flaky tarball download, unrelated to the change. A retry succeeded.)

## Remaining steps to finish the GHCR repoint

1. **Commit the fix.** On `main` (default branch) prefer a short-lived branch:
   ```bash
   git checkout -b fix/control-plane-dockerfile-bun-isolated-nodemodules
   git add control-plane/Dockerfile
   git commit -m "fix(build): ship control-plane workspace node_modules (bun 1.4 isolated layout)"
   git push -u origin HEAD
   ```
   Then merge to `main` (PR or fast-forward). `release.yml` triggers on push to `main`
   (and on `v*` tags), so the merge rebuilds and pushes a good multi-arch
   `ghcr.io/muditgarg007/control-plane:latest` + `:$GITHUB_SHA`.

   The Dockerfile change alters the build content hash, so the B2 content-hash build cache
   (commit `5ad0346`) will **not** skip the rebuild — a real rebuild happens.

2. **Confirm the new image boots before deploying.** After the release run succeeds:
   ```bash
   DIG=$(docker buildx imagetools inspect ghcr.io/muditgarg007/control-plane:latest | awk '/^Digest:/{print $2}')
   docker run --rm ghcr.io/muditgarg007/control-plane@$DIG   # expect: Missing required env var: DATABASE_URL
   ```

3. **Repoint the live deploy** to the new digest (pin by digest, not the moving tag), on
   the box:
   ```bash
   helm upgrade control-plane deploy/helm/control-plane/ -n autosploit-system \
     --reuse-values \
     --set image.repository=ghcr.io/muditgarg007/control-plane \
     --set image.tag=latest@$DIG
   kubectl rollout status deploy/control-plane-control-plane-app -n autosploit-system
   ```
   `--reuse-values` keeps the existing secret and the Postgres-only `external.*` wiring.
   The GHCR package is public (it pulls on the box with no auth), so no pull secret is
   needed. If the rollout misbehaves, `helm rollback control-plane` returns to the working
   `h3-local` revision with no downtime (the old pod is kept until the new one is Ready).

4. **Verify:** pod `1/1 Running`, and the engagement CiliumNetworkPolicy edge-4 ALLOW still
   matches `app: control-plane` on container port 3000 (unchanged by this fix). The H3
   red-team gate (`docs/vps-backend-deploy-handoff.md` verification §4) does not need to be
   re-run for an image-only change, but re-running it is the definitive proof if desired.

### Faster alternative (skip CI)

Build the fixed multi-arch image locally/on the box and `docker push` straight to GHCR
(needs a GHCR **write** PAT, `write:packages`), then do step 3. Still commit the Dockerfile
fix so CI stops publishing broken images.

## Open items / watch-outs

- **Harness image** (`./harness`, Python) is built by the same workflow but is not a bun
  monorepo build, so it is almost certainly unaffected. Not verified this session — worth a
  boot check if the harness ever fails to start.
- **Capacity tuning / full stateful deps (Redis/Vault/Redpanda) / R2** remain as in
  `docs/vps-backend-deploy-handoff.md`; none are blocked by this fix.
- The VPS checkout is on `h3-contabo-seam1-chart-fixes` (old bun 1.1.0 Dockerfile). After
  landing the fix, pull `main` on the box so any local rebuild there also uses the fixed
  Dockerfile.
