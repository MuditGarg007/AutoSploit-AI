# Backend → VPS deploy — handoff

**Date:** 2026-10-07
**Branch:** `feat/capacity-b2-build-cache` (the GKE cleanup below is orthogonal to that
branch's capacity work; move it to its own branch if you prefer a clean history)
**Authoritative runbook:** `docs/vps-h3-runbook.md` — this handoff is the condensed
execution checklist; the runbook carries the full rationale, resource budget, and
corrected invocation notes. Read them together.

## Context

The backend was originally designed against **GKE** (demo substrate only). The settled
decision (`deferred-open-items.md` item 2) is **self-hosted kind + Cilium + gVisor +
Kaniko on a single KVM VPS**. The box is **Contabo `root@169.58.86.230`, 4 vCPU / 8 GB**.
The H3 red-team exit gate already passed **GREEN on that box on 2026-10-06**, so the
substrate is proven; what remains is a clean, repeatable deploy of the long-lived
backend.

The "backend" is two things:
- **Control plane** — the long-lived NestJS API + BullMQ worker (one image, one
  Deployment), listens on container port **3000**, Service on **80**. Helm chart:
  `deploy/helm/control-plane/`. This is what this handoff deploys.
- **Per-engagement engine** — conductor `--k8s` drives ephemeral target/attacker pods
  per engagement. Already substrate-agnostic; nothing to deploy up front.

## Done in this session (code + docs)

- **`.github/workflows/release.yml`** — removed the `deploy-gke` job, `GKE_CLUSTER`/
  `GKE_REGION` env, and the `id-token: write` permission. The workflow is now
  **build → scan → leak-check → push to GHCR** only (control-plane + harness, multi-arch).
  Deploy and the red-team gate are manual on the VPS.
- **Docs** — corrected stale "GKE is the deploy/prod substrate" narrative and the
  factually-wrong infra claims (`main.tf` is GKE-free; the old CI job names are gone) in
  `component-h-hardening.md`, `control-plane.md`, `orchestration.md`,
  `deferred-open-items.md`, `m5-phases.md`, `ci-recovery-handoff.md`, plus one-line
  comments in `values.yaml` and `redteam.sh`. The three runbooks + the roadmap were left
  as-is (they already mark GKE superseded). Public `gcr.io` Kaniko/crane images are not
  GKE and were left untouched.

Decisions taken for the remaining work: deploy is **manual** (operator-run); stateful
deps stay **ops-owned** (no new in-repo manifests); the GKE cleanup covered **code + docs**.

## Remaining steps — run on the VPS

Run from a checkout of this repo on `root@169.58.86.230`. Each step maps to the runbook
section in parentheses. **Do not skip the gates** (`--smoke` must be green before deploy;
red-team must be green to call it done).

### 1. Host preflight (runbook §4.2, §9)

```bash
systemd-detect-virt            # MUST print: kvm   (Contabo also sells OpenVZ/LXC — reject those)
ls /sys/kernel/btf/vmlinux     # must exist (Cilium needs BTF)
which docker kind kubectl cilium helm   # all must be on PATH
# gVisor: runsc + containerd-shim-runsc-v1 in /usr/local/bin (verify the .sha512 before install)
```

Leave host-level egress **permissive** — no ufw / Contabo-panel egress rule. A host
firewall masks the in-cluster SEAM-1 enforcement the red-team pass is supposed to prove.

### 2. Swap (runbook §4.3)

Add a 6 GB swapfile + `/etc/fstab` entry — a spike safety net so a large `FROM` base in a
Kaniko build cannot OOM-kill the kind node.

```bash
sudo fallocate -l 6G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3. Cluster bring-up — GATE (runbook §5.1–5.2)

```bash
CILIUM_VERSION=<verified-ver> ./scripts/m4-bootstrap.sh --smoke
```

Try the pinned `1.21.0-pre.2` first. If `cilium status` is unhealthy on the Ubuntu
kernel, retry with current stable `1.21.x` and **record the working version as the VPS
pin**. The script installs kind + Cilium + the gVisor `runsc` RuntimeClass (pinned to
`systrap`) and enables containerd `certs.d` for the in-cluster registry. **Do not proceed
until `--smoke` is green** — it proves a gVisor pod schedules and default-deny egress bites.

### 4. Off-box report blobs (runbook §3.2)

Create a Cloudflare R2 bucket `autosploit-reports` + an access key/secret (S3-protocol;
Backblaze B2 is an equivalent fallback). No MinIO on the box. These feed the
`--set external.s3*` flags in step 7.

### 5. GHCR pull secret (runbook §3.3)

Create a read-only GHCR PAT (`read:packages`), then:

```bash
kubectl create namespace autosploit-system
kubectl create secret docker-registry ghcr-pull -n autosploit-system \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<PAT>
```

Alternatively make the `muditgarg007/control-plane` and `muditgarg007/harness` GHCR
packages public and skip the secret (then drop the `--set image.pullSecrets[0].name` flag
in step 7).

### 6. Stand up stateful deps — MANUAL, ops-owned (runbook §5.3)

The control-plane chart ships **only** the plane Deployment + Service. Bring up minimal
single-replica **Postgres, Redis, Redpanda (reduced-memory flags — it is the hungriest on
8 GB), and Vault** in `autosploit-system` first, so the plane's `/health` readiness can
pass. Capture their in-cluster endpoints for the `--set external.*` flags. Resource budget
(runbook §6): ~4.6 GB steady, leaving ~3.4 GB headroom for one engagement — this only
fits at **concurrency = 1** (see gotcha 1).

Then create the control-plane secret (runbook §5.3):

```bash
kubectl create secret generic control-plane-secrets -n autosploit-system \
  --from-literal=INGEST_TOKEN_SIGNING_KEY=... \
  --from-literal=JWT_ACCESS_SECRET=... --from-literal=JWT_REFRESH_SECRET=... \
  --from-literal=GITHUB_CLIENT_ID=... --from-literal=GITHUB_CLIENT_SECRET=... \
  --from-literal=GITHUB_CALLBACK_URL=... --from-literal=VAULT_TRANSIT_KEY=...
```

**Invariant:** `OPENROUTER_API_KEY` must NEVER be in this secret or the plane — it is
conductor/harness-side only. The CI leak scanner and the chart both forbid it.

### 7. Install the control plane (runbook §5.3)

```bash
helm install control-plane deploy/helm/control-plane/ -n autosploit-system \
  --set image.repository=ghcr.io/muditgarg007/control-plane \
  --set image.tag=<sha-or-latest> \
  --set image.pullSecrets[0].name=ghcr-pull \
  --set external.s3Endpoint=https://<accountid>.r2.cloudflarestorage.com \
  --set external.s3Bucket=autosploit-reports \
  --set external.postgresUrl=postgres://... \
  --set external.redisUrl=redis://... \
  --set external.kafkaBrokers=... \
  --set external.vaultAddr=http://vault:8200
kubectl rollout status deploy/control-plane-control-plane-app -n autosploit-system
```

Watch for `1/1 Running`. The pod carries the label `app: control-plane` and container
port 3000 — exactly the match target for the engagement CiliumNetworkPolicy's edge-4
ALLOW (`conductor .../k8s/manifests.py`). See gotcha 2 on the `image.repository` default.

## Verification — the exit proof

1. `m4-bootstrap.sh --smoke` green (done in step 3).
2. Control plane `1/1 Running`, `/health` ready in `autosploit-system`.
3. Run one engagement to create the policed namespace:
   ```bash
   conductor run <small-dockerfile-repo> --k8s --target-port <port>
   ```
   Use a **small** target Dockerfile for the first pass (Kaniko is serialized).
4. **H3 red-team gate — the production exit proof** (runbook §7.2; note the corrected
   invocation — `--plane-ns`, the full Service DNS name, and a real `--ingest-token`):
   ```bash
   ./scripts/redteam.sh \
     --namespace engagement-<id> \
     --plane-ns autosploit-system \
     --model-host api.openrouter.ai \
     --ingest-url http://control-plane-control-plane.autosploit-system.svc.cluster.local:80/engagements/<id>/events \
     --ingest-token <token>
   ```
   Expected: SEAM-1 — exactly three ALLOW edges (target, model API, plane :80); the DENY
   set (arbitrary internet + ports 5432 / 6379 / 9092) has **zero** successes. SEAM-2 — no
   GitHub token in logs or the harness, model key never in the plane. A red line is a real
   seam breach — **fix the seam, never loosen the test.**

A green run closes the production deploy.

## Gotchas

1. **Concurrency tension — resolve before tuning.** `vps-h3-runbook.md §2` holds
   concurrency at **1** (RAM-bound on 8 GB). The newer `docs/capacity-cpu-handoff.md`
   (measured 2026-10-07) argues CPU is the real limit and concurrency can rise.
   **Recommendation: deploy the baseline at concurrency 1 (proven), get a green H3, then
   tune separately** using the capacity doc. Do not fold capacity tuning into the first
   deploy.
2. **Chart `image.repository` default is wrong for this owner.** It defaults to
   `ghcr.io/autosploit/control-plane`; override it to `ghcr.io/muditgarg007/control-plane`
   (the real GHCR owner, per `release.yml`) on `helm install`.
3. **Capacity knobs reach the pod only via `.Values.env` passthrough.** The implemented
   A1/A2/B2 levers are not first-class chart keys. Pass them as, e.g.,
   `--set env.WORKER_CONCURRENCY=3 --set env.BUILD_CONCURRENCY=2` and, once a long-lived
   cache registry exists, `--set env.BUILD_CACHE_REGISTRY=...`. Only after a green baseline
   (gotcha 1).

## Follow-ups (not blocking the first deploy)

- **`deploy-vps` CI job** (runbook §7.4) — SSH to the box, bootstrap + `helm install`, run
  `redteam.sh` over the remote context as the release gate. Add only after the first
  reproducibly-green manual pass.
- **In-repo manifests for stateful deps** — deliberately ops-owned today; codify later if
  the manual bring-up proves error-prone.
- **Capacity concurrency tuning** — `docs/capacity-cpu-handoff.md`, a separate workstream.
- **Pre-existing `provisioner/.../build/booter` gap** — breaks 3 conductor tests
  (`CLAUDE.md`); unrelated to the `--k8s` deploy path (it imports `run` lazily), but worth
  closing eventually.
