# H3 on Contabo — session handoff (resume at Phase D)

> Working handoff for closing the **H3 isolation-hardening exit gate (step 3)** on a
> Contabo VPS. Phases A–C are done; this file is everything the next session needs to
> run **Phase D (deps + control-plane)** and **Phase E (the red-team gate)**. Companion
> to `docs/vps-h3-runbook.md` (the full runbook, already Contabo-adapted) and the memory
> `h3-contabo-progress.md`. Delete this file once H3 is closed.

## Objective

H3 = `scripts/redteam.sh` green against the **real** CiliumNetworkPolicy under **live
egress**: SEAM-1 (egress matrix — three ALLOW edges, DENY set zero) + SEAM-2 (secret
split). A green run closes step 3.

## The box

- **Contabo VPS, 4 vCPU / 8 GB**, Ubuntu 24.04, kernel 6.8.0-139, KVM confirmed.
- Access: `ssh root@169.58.86.230` (key auth already works from the dev box; root).
- Repo on box: `/root/AutoSploit-AI`, checked out on branch
  `h3-contabo-seam1-chart-fixes`, tracking origin, clean.
- Dev-box repo: `/home/mudit/AutoSploit-AI`, same branch.

## Branch & commits (off `main`, unmerged)

Branch `h3-contabo-seam1-chart-fixes`:
- `ca2e206` — Phase A: control-plane chart gets pod label `app: control-plane`
  (SEAM-1 edge-4 match) + `image.pullSecrets` support; `docs/vps-h3-runbook.md`
  corrected for Contabo and the real chart keys/ns/URL.
- `05dd40f` — Phase C: kind node mounts the gVisor sidecar dir `/usr/local/bin/gvisor-bin`
  so release-2026xx runsc can start the sandbox; bootstrap header documents staging it.

## Done so far

**Phase A — repo patches (committed):**
- `deploy/helm/control-plane/templates/app-deployment.yaml`: pod *template* label
  `app: control-plane` (selector untouched) + `imagePullSecrets` rendered from
  `.Values.image.pullSecrets`.
- `deploy/helm/control-plane/values.yaml`: `image.pullSecrets: []`.
- `docs/vps-h3-runbook.md`: Contabo delta, corrected keys/ns/URL (see Gotchas).
- Verified: `helm lint` clean; label always renders, pull secret only when set.

**Phase B — box provisioned:** docker 29.8.2, kind v0.24.0, kubectl v1.31.14,
cilium-cli v0.20.1, helm v3.22.0, gVisor release-20260928.0, 6 GB swap (in `/etc/fstab`),
ufw inactive (host egress left permissive — required, or SEAM-1 is masked).

**Phase C — M4 smoke GREEN:** `./scripts/m4-bootstrap.sh --smoke` passes. Cilium
**1.21.0-pre.2 (bootstrap default) is healthy on the Ubuntu 6.8 kernel — no re-pin
needed**. gVisor Pod runs spoofed `4.19.0-gvisor` (host 6.8); default-deny-egress blocks.
kind cluster `autosploit-hardening` is **up and Ready right now** (kubeconfig
`/root/.kube/config`, context `kind-autosploit-hardening`).

## Current cluster state

- Cluster `autosploit-hardening` running, node Ready, Cilium OK.
- Namespace `m4-proof` left over from the smoke (harmless; `kubectl delete ns m4-proof`
  to clear).
- `autosploit-system` namespace does **not** exist yet — Phase D creates it.

## Phase D — deps + control-plane (DO THIS NEXT)

The control-plane chart ships only the plane Deployment + Service; it does **not** ship
Postgres/Redis/Redpanda/Vault/S3 (`values.yaml` `external.*` are endpoints). For H3 the
plane must reach **1/1 Running + Ready** (readiness `/health`) so SEAM-1 edge 4 has a
Service endpoint. On 8 GB this is the tightest step — Redpanda is the hungriest, start it
with trimmed memory. Swap is the cushion. Concurrency stays **1** (RAM-bound; the extra
cores only speed Kaniko — do not raise it).

Steps (run over SSH from `/root/AutoSploit-AI`, `export KUBECONFIG=/root/.kube/config`):

1. **Namespace + GHCR pull secret**
   ```bash
   kubectl create namespace autosploit-system
   kubectl create secret docker-registry ghcr-pull -n autosploit-system \
     --docker-server=ghcr.io --docker-username=<GHCR_USER> --docker-password=<GHCR_PAT>
   ```
   (Skip the secret if the `control-plane`/`harness` GHCR packages are public.)

2. **Minimal stateful deps in `autosploit-system`** — single replica each:
   Postgres, Redis, Redpanda (reduced memory: e.g. `--smp 1 --memory 1G --reserve-memory 0M
   --overprovisioned`), Vault (dev/minimal — the kept `vault_*` transit engine in
   `deploy/terraform/main.tf` is the trust-split backend). Note the in-cluster DNS names
   you give them — they become the `external.*` values in step 4.

3. **control-plane-secrets** (never OPENROUTER_API_KEY — the chart forbids it and the CI
   leak scanner guards it):
   ```bash
   kubectl create secret generic control-plane-secrets -n autosploit-system \
     --from-literal=INGEST_TOKEN_SIGNING_KEY=<rand> \
     --from-literal=JWT_ACCESS_SECRET=<rand> \
     --from-literal=JWT_REFRESH_SECRET=<rand> \
     --from-literal=GITHUB_CLIENT_ID=<id> \
     --from-literal=GITHUB_CLIENT_SECRET=<secret> \
     --from-literal=GITHUB_CALLBACK_URL=<url> \
     --from-literal=VAULT_TRANSIT_KEY=github-tokens
   ```
   Keep the `INGEST_TOKEN_SIGNING_KEY` value — Phase E needs a matching ingest token.

4. **Install the control plane** into `autosploit-system`:
   ```bash
   helm install control-plane deploy/helm/control-plane/ -n autosploit-system \
     --set image.pullSecrets[0].name=ghcr-pull \
     --set external.s3Endpoint=https://<R2_ACCT>.r2.cloudflarestorage.com \
     --set external.s3Bucket=autosploit-reports \
     --set external.postgresUrl=postgres://... \
     --set external.redisUrl=redis://... \
     --set external.kafkaBrokers=... \
     --set external.vaultAddr=http://vault.autosploit-system.svc:8200
   kubectl rollout status deploy/control-plane-control-plane-app -n autosploit-system
   ```
   (The image repo defaults to `ghcr.io/autosploit/control-plane:latest`; override
   `image.repository` to `ghcr.io/<owner>/control-plane` if the CI pushes under a
   different owner — CI uses `ghcr.io/${github.repository_owner}/control-plane`.)

5. **Confirm readiness + the SEAM-1 wiring:**
   ```bash
   kubectl get pod -n autosploit-system -l app=control-plane -o wide        # 1/1 Running
   kubectl get endpoints -n autosploit-system                                # Service has an endpoint
   kubectl get pod -n autosploit-system -l app=control-plane -o jsonpath='{.items[0].metadata.labels}'  # app=control-plane present
   ```

### Credentials the operator must supply for Phase D
1. GHCR username + PAT (`read:packages`) — or confirm packages are public.
2. Cloudflare R2 account id + access key + secret (bucket `autosploit-reports`). R2 is
   only the report archive path; **SEAM-1/SEAM-2 do not need R2** — if R2 is deferred,
   the plane just needs to be Ready, so a dummy/omitted S3 endpoint is acceptable for
   the gate as long as the pod still goes Ready.
3. OpenRouter key — **conductor-side only, Phase E**; must never enter the plane
   (see memory `leaked-openrouter-keys`).

### Phase D risk
The control-plane image's readiness `/health` may hard-depend on Postgres/Redis being
reachable; if the pod won't go Ready without them, that is exactly why step 2 brings the
deps up first. If deps destabilize the 8 GB box, fall back to proving **SEAM-1 first**
(target + model ALLOW, DENY-zero — no plane needed), then bring the plane up for edge 4 +
SEAM-2 as a second pass.

## Phase E — the gate (after the plane is Ready)

1. Create the policed namespace via a small engagement (`--k8s` requires `--target-port`):
   ```bash
   conductor run <small-dockerfile-repo> --k8s --target-port <port>
   ```
   Creates `engagement-<id>` with the CiliumNetworkPolicy applied fail-closed before any
   Pod. Use a small Dockerfile (4 cores help Kaniko but it is still serialized).

2. Run the red-team pass (corrected invocation — all three fixes matter):
   ```bash
   ./scripts/redteam.sh \
     --namespace engagement-<id> \
     --plane-ns autosploit-system \
     --model-host api.openrouter.ai \
     --ingest-url http://control-plane-control-plane.autosploit-system.svc.cluster.local:80/engagements/<id>/events \
     --ingest-token <token-signed-with-INGEST_TOKEN_SIGNING_KEY>
   ```

### Exit criterion
- **SEAM-1**: exactly three ALLOW edges succeed — attacker→target, attacker→model API
  (`toFQDNs api.openrouter.ai:443`), attacker→control-plane:80 — and the DENY set
  (arbitrary internet + ports 5432/6379/9092) has **zero** successes.
- **SEAM-2**: no synthetic GitHub token in probe/harness logs; `OPENROUTER_API_KEY` value
  absent from all `autosploit-system` pod logs.
- Green banner `RED-TEAM PASS GREEN` → **H3 closed, step 3 done.** The script fails loudly
  on any deviation — a red line is a real seam breach; fix the seam, never loosen the test.

### After green
- Update memory `h3-contabo-progress.md` and the roadmap/deferred-items H3 lines to closed.
- Consider merging `h3-contabo-seam1-chart-fixes` to main and (optional) adding a
  `deploy-vps` CI job replacing `deploy-gke` (`release.yml`).

## Gotchas already handled (don't re-discover)

- **gVisor sidecar dir**: the `latest/<arch>` direct download 404s; install runsc via the
  GPG-signed apt repo (`storage.googleapis.com/gvisor`). release-2026xx runsc needs
  `/usr/local/bin/gvisor-bin/` (gvisor_sentry etc) or the sandbox fails under
  `--sidecar-usage-policy=STRICT`. Staged on the box + mounted via the kind config
  (committed). Already in place on this box.
- **Cilium pin**: 1.21.0-pre.2 (bootstrap default) works on Ubuntu 6.8 — no override.
- **Chart key mismatches (fixed in the chart/runbook already)**: S3 keys are
  `external.s3Endpoint` / `external.s3Bucket` (not `reports.s3.*`); pull secret is
  `image.pullSecrets[0].name` (not `image.pullSecret`); the plane lives in
  `autosploit-system` with pod label `app: control-plane` — both are what the engagement
  CiliumNetworkPolicy edge-4 ALLOW matches (`conductor/.../k8s/manifests.py`
  CONTROL_PLANE_SELECTOR / CONTROL_PLANE_NAMESPACE).
- **Service name**: the chart Service is `control-plane-control-plane` (release+chart),
  not `control-plane` — use the full FQDN in the ingest URL.
- **`--ingest-token` is required** or `redteam.sh` skips the control-plane POST, leaving
  SEAM-1 edge 4 unproven.
- **terraform**: `deploy/terraform/main.tf` is already stripped to minimal Vault — the
  runbook §3.1 strip list is now an audit, no action.

## Known unrelated issue (pre-existing, not ours)

`provisioner` `build/` package missing breaks collection of three conductor test files
(`test_run.py`, `test_scaffold.py`, `test_teardown.py`) — see root `CLAUDE.md`. Does not
affect the Phase-B k8s path or H3. `conductor run --k8s` imports `run` lazily, so it is
unaffected.
