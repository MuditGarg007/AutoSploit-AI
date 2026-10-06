# H3 on Contabo — session handoff (resume at Phase E)

> Working handoff for closing the **H3 isolation-hardening exit gate (step 3)** on a
> Contabo VPS. **Phases A–D are done**; this file is everything the next session needs to
> run **Phase E (the red-team gate)** and close step 3. Companion to
> `docs/vps-h3-runbook.md` (the full runbook) and the memory `h3-contabo-progress.md`.
> Delete this file once H3 is closed.

## Objective

H3 = `scripts/redteam.sh` green against the **real** CiliumNetworkPolicy under **live
egress**: SEAM-1 (egress matrix — three ALLOW edges, DENY set zero) + SEAM-2 (secret
split). A green run closes step 3.

## The box

- **Contabo VPS, 4 vCPU / 8 GB**, Ubuntu 24.04, kernel 6.8.0-139, KVM confirmed.
- Access: `ssh root@169.58.86.230` (key auth already works from the dev box; root).
- Repo on box: `/root/AutoSploit-AI`, branch `h3-contabo-seam1-chart-fixes`, tracking
  origin. Keep `git checkout -- bun.lock` handy: a non-frozen `bun install` run on the box
  can leave the lockfile dirty, and the build mounts the repo.
- Dev-box repo: `/home/mudit/AutoSploit-AI`, same branch.
- `export KUBECONFIG=/root/.kube/config`, context `kind-autosploit-hardening`.

## Current cluster state (Phase D complete — verified 2026-10-06)

- kind cluster `autosploit-hardening` up, node Ready, Cilium 1.21.0-pre.2 healthy.
- Namespace `autosploit-system` holds:
  - **control-plane — 1/1 Running + Ready.** Helm release `control-plane`, REVISION 2.
    Deployment `control-plane-control-plane-app`, Service `control-plane-control-plane`
    (ClusterIP :80 → pod :3000, endpoint present). Pod carries label `app: control-plane`
    (SEAM-1 edge-4 selector). `GET /health` returns `{"status":"ok","db":"up"}`.
  - **postgres — 1/1 Running.** Deployment + Service `postgres` (ClusterIP :5432), db
    `control_plane`, `POSTGRES_HOST_AUTH_METHOD=trust`. This is the only stateful dep.
  - Secret `control-plane-secrets` (all 7 keys the chart requires).
- **Redis / Redpanda / Vault / S3 are intentionally NOT deployed** (lean path — see below).
- `m4-proof` namespace deleted.

## Branch & commits (off `main`, unmerged)

Branch `h3-contabo-seam1-chart-fixes`, newest first:
- `0505cb1` fix(control-plane): inject Worker explicitly in EngagementWorkerLifecycle
- `5f265b5` fix(control-plane): make node_modules readable by the non-root runtime user
- `93a19a5` fix(control-plane): use turbo filter by package name for the build step
- `17a36d1` fix(control-plane): copy full workspace before frozen bun install
- `60c4722` fix(control-plane): stage client workspace manifest for frozen bun install
  *(superseded by `17a36d1`; harmless)*
- `274dfda` fix(control-plane): drop invalid bun --production=false flag in Dockerfile
- `18e845e`..`ca2e206` — the earlier Phase A/C work (chart label, gVisor sidecar dir).

## What Phase D proved and decided (so Phase E does not re-derive it)

1. **No image was ever in GHCR.** `release.yml` fires only on `v*` tags / `workflow_dispatch`
   and has never run, so `ghcr.io/muditgarg007/control-plane` and `.../harness` do **not**
   exist (both 404). GHCR owner is `muditgarg007` (lowercased). **Build images locally on
   the box and `kind load` them** — no pull secret, no release. The same applies to the
   harness image in Phase E.
2. **Lean deps = Postgres only.** `/health` does a real `SELECT 1` (Postgres mandatory),
   Redis-down is tolerated at boot (background ioredis retry), and Kafka is disabled via
   empty brokers (below). So Postgres alone gets the plane Ready. Redpanda (the 8 GB memory
   hog) is not needed for the gate.
3. **Kafka must be disabled or the plane crash-loops.** Unguarded telemetry consumers
   (`control-plane/src/domains/telemetry/consumers/*.consumer.ts`) connect at boot; a
   non-retriable `getaddrinfo EAI_AGAIN redpanda` kills the process. The control-plane was
   installed with `--set external.kafkaBrokers="" --set external.schemaRegistryUrl=""`,
   which makes `kafkaFactory` return null so every consumer short-circuits
   (`if (!this.kafka) return`). Keep these two overrides on any `helm upgrade`.
4. **Six latent bugs were fixed** (all latent because `release.yml` never built the image):
   see the commit list. The image now builds, loads, and the pod goes Ready.

### The control-plane image + exact install (already applied; shown for rebuilds)

```bash
# On the box, from /root/AutoSploit-AI:
docker build -f control-plane/Dockerfile -t control-plane:h3-local .   # ~5 min; chmod step is slow
kind load docker-image control-plane:h3-local --name autosploit-hardening

helm upgrade --install control-plane deploy/helm/control-plane/ -n autosploit-system \
  --set image.repository=control-plane \
  --set image.tag=h3-local \
  --set image.pullPolicy=IfNotPresent \
  --set external.kafkaBrokers="" \
  --set external.schemaRegistryUrl=""
kubectl rollout status deploy/control-plane-control-plane-app -n autosploit-system
```

The image is ~1.79 GB (a full `COPY . .` pulls the `client` workspace's deps too). That is
fine for the gate; slim later if desired. The `chmod -R a+rX /app` layer is the slow part
of each rebuild — budget a few minutes.

## Phase E — the gate (DO THIS NEXT)

The operator will **supply an OpenRouter key**, so SEAM-2 proves the real split (the key is
present conductor-side, absent from the plane). Wire it conductor-side only — see
`leaked-openrouter-keys` memory. It must never be set on the control-plane.

### E0. Prerequisites to stand up

1. **Build + load the harness (attacker) image** — same local path as control-plane,
   because it is not in GHCR either:
   ```bash
   # from /root/AutoSploit-AI
   docker build -f harness/Dockerfile -t harness:h3-local harness/
   kind load docker-image harness:h3-local --name autosploit-hardening
   ```
   The harness Dockerfile is Python/uv (`uv sync --frozen`), build context `harness/`
   (it COPYs `pyproject.toml uv.lock README.md src`). **Watch for the same class of
   frozen-lockfile / missing-path failures that bit the control-plane build** — if
   `uv sync --frozen` complains the lock drifted, or a workspace/path dep is missing from
   the build context, fix it the same way (stage what the lock needs, or relax the context)
   and commit. Verify the image lands on the node:
   `docker exec autosploit-hardening-control-plane crictl images | grep harness`.

2. **Install conductor on the box** (Python ≥3.12 pkg, CLI entry `conductor`):
   ```bash
   cd /root/AutoSploit-AI/conductor
   python3 -m venv .venv && . .venv/bin/activate
   pip install -e .          # or: uv pip install -e .
   conductor --help
   ```
   Note the known unrelated gap: the provisioner `build/` package is missing, which breaks
   collection of three conductor *test* files but not the `--k8s` run path (`conductor run`
   imports Phase-A `run` lazily). See root `CLAUDE.md`. If `conductor run --k8s` itself
   fails to import on the provision seam, fall back to applying the engagement namespace +
   CiliumNetworkPolicy directly from `conductor/src/autosploit_conductor/k8s/manifests.py`
   (the policy is what SEAM-1 actually tests) and skip the conductor driver.

3. **A small Dockerfile target repo.** `conductor run --k8s` requires `--target-port`, and
   `redteam.sh` probes the target at **`http://target:8080/`** (hard-coded 8080). So the
   target must listen on 8080. Create a trivial repo, e.g. a one-line Dockerfile:
   ```dockerfile
   FROM python:3.12-slim
   EXPOSE 8080
   CMD ["python", "-m", "http.server", "8080"]
   ```
   Conductor builds it in-cluster with Kaniko (M8 registry path), so a Dockerfile repo
   (local path or git URL) is the input to `conductor run`.

### E1. Create the policed engagement namespace

```bash
cd /root/AutoSploit-AI/conductor && . .venv/bin/activate
export AUTOSPLOIT_HARNESS_IMAGE=harness:h3-local      # overrides the GHCR placeholder
export OPENROUTER_API_KEY=<operator-supplied-key>     # conductor-side ONLY; never the plane
conductor run <path-to-small-dockerfile-repo> --k8s --target-port 8080
```

This creates `engagement-<id>` with the CiliumNetworkPolicy applied fail-closed before any
Pod, provisions the Kaniko-built target, and runs the harness. The conductor reads
`OPENROUTER_API_KEY` from its own env and injects it into the per-engagement Secret
`model-key` (`k8s/manifests.py` `SECRET_NAME`/`API_KEY_ENV`); the harness pod reads it. The
key never touches `autosploit-system`.

Pods default to `restartPolicy: Never` and are tagged, not `:latest`, so the kind-loaded
local images resolve under the default `IfNotPresent` policy. If the attacker/target pod
reports `ErrImagePull`/`ImagePullBackOff`, the pod spec is forcing a pull — set its image
pull policy to `IfNotPresent`/`Never` (check `k8s/client.py` around the `image=` kwarg at
line ~216 and `k8s/manifests.py`).

Capture the `engagement-<id>` id from the conductor output; redteam needs it.

### E2. Mint an ingest token

The ingest token is a **JWT, HS256**, signed with `INGEST_TOKEN_SIGNING_KEY` (saved on the
box at `/root/h3-ingest-signing-key.txt`). Claims (see
`control-plane/src/domains/lifecycle/ingest-token.service.ts` `mint()`): payload
`{ type: "ingest", scope: "events" }`, `sub = <engagement-id>`, `iat` now, `exp` now + 6h.
Mint it with the same `jose` the plane uses, e.g. on the box:

```bash
ENG=engagement-<id>
KEY=$(cat /root/h3-ingest-signing-key.txt)
# node with jose available inside the control-plane image, or a small script:
TOKEN=$(docker run --rm -e KEY="$KEY" -e SUB="$ENG" node:22-slim sh -c '
  npm i jose >/dev/null 2>&1;
  node -e "import(\"jose\").then(async j => {
    const k = new TextEncoder().encode(process.env.KEY);
    const t = await new j.SignJWT({type:\"ingest\",scope:\"events\"})
      .setProtectedHeader({alg:\"HS256\"}).setSubject(process.env.SUB)
      .setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+21600).sign(k);
    console.log(t);
  })"')
echo "$TOKEN"
```

(Any HS256 signer with those claims works; the `sub` must equal the engagement id the
ingest URL targets.)

### E3. Run the red-team pass

```bash
cd /root/AutoSploit-AI
./scripts/redteam.sh \
  --namespace engagement-<id> \
  --plane-ns autosploit-system \
  --target-svc target \
  --model-host api.openrouter.ai \
  --ingest-url http://control-plane-control-plane.autosploit-system.svc.cluster.local:80/engagements/<id>/events \
  --ingest-token "$TOKEN"
```

What the script asserts (from `scripts/redteam.sh`):
- **SEAM-1 ALLOW**: `http://target:8080/` reachable; `https://api.openrouter.ai/` reachable
  (TLS reachability only — **no API key needed for this edge**); control-plane ingest POST
  reachable (needs the token, else the edge is skipped).
- **SEAM-1 DENY (must be zero)**: plane ports 5432/6379/9092 dropped, and
  `https://example.com/` (arbitrary internet) dropped.
- **SEAM-2**: `OPENROUTER_API_KEY` value absent from all `autosploit-system` pod logs; no
  synthetic GitHub token in probe/harness logs.

### Exit criterion

Green banner `RED-TEAM PASS GREEN` → **H3 closed, step 3 done.** The script fails loudly on
any deviation — a red line is a real seam breach; fix the seam, never loosen the test.

### After green
- Update memory `h3-contabo-progress.md` and the roadmap/deferred-items H3 lines to closed.
- Delete this handoff file.
- Consider merging `h3-contabo-seam1-chart-fixes` to main and (optional) a `deploy-vps` CI
  job replacing `deploy-gke` in `release.yml`. Cutting a `v*` tag would exercise the now-fixed
  Dockerfile for the first time in CI.

## Gotchas already handled (don't re-discover)

- **Images are local, not GHCR.** Build on the box + `kind load`, tag `*:h3-local`,
  `pullPolicy=IfNotPresent`. GHCR owner is `muditgarg007`.
- **Kafka disabled** via `external.kafkaBrokers="" external.schemaRegistryUrl=""`. Keep it.
- **Postgres is the only dep** needed for the plane to go Ready.
- **control-plane Dockerfile** was broken in four ways (bun flag, partial workspace copy vs
  frozen lock, `bun --filter` path syntax, non-root file perms) — all fixed on the branch.
  **Expect the harness Dockerfile may have similar latent issues** (it has also never been
  built in CI); fix and commit as you hit them.
- **Chart keys / names**: S3 keys are `external.s3Endpoint`/`external.s3Bucket`; the plane
  Service is `control-plane-control-plane` (use the full FQDN in the ingest URL); pod label
  is `app: control-plane`; plane ns is `autosploit-system`.
- **`--ingest-token` is required** or `redteam.sh` skips the control-plane POST, leaving
  SEAM-1 edge 4 unproven.
- **gVisor sidecar dir** and **Cilium 1.21.0-pre.2** are already staged/proven on the box
  (Phase C). No action.

## Known unrelated issue (pre-existing, not ours)

`provisioner` `build/` package missing breaks collection of three conductor test files
(`test_run.py`, `test_scaffold.py`, `test_teardown.py`) — see root `CLAUDE.md`. Does not
affect the `--k8s` run path.
