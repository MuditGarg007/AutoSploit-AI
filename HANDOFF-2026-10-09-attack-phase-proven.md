# Handoff — Full pipeline proven end to end; node-pull + harness wired

**Date:** 2026-10-09 (same day the Kaniko-build handoff was closed)
**Session owner:** Mudit Garg
**Environment:** Contabo VPS, `ssh root@169.58.86.230`, single-node kind cluster
(`autosploit-hardening`, control-plane node `autosploit-hardening-control-plane`),
namespace `autosploit-system`.
**Repo:** `origin/main` at `008a243`. Frontend on Vercel (git-connected, auto-deploys
`main`); backend on the VPS via Helm (manual rolls), now at **revision 18**, image
`ghcr.io/muditgarg007/control-plane:508c75d` (unchanged — only the chart changed this
session, no image rebuild).

---

## TL;DR

The engagement pipeline now runs **fully end to end, including the attack phase** —
proven live through the dashboard against the private testbed
`MuditGarg007/Autosploit-test`. A real dashboard engagement went:
auth → create → worker → conductor (in-process) → git clone → per-engagement
namespace + registry → Kaniko build → **target Pod pulls the built image and runs**
→ **attacker (harness) Pod runs and exploits the target**. The harness found four
seeded vulns in ~14 s (data leak, SSTI, OS command injection as root, path traversal
leaking source + the Werkzeug `SECRET`), spending $0.0017 of the $5 cap.

The two faults that blocked the attack phase (both surfaced the moment the Kaniko
build first succeeded) are fixed in the Helm charts, committed, and deployed (rev 18).

---

## The two blockers (both node-pull, not conductor logic)

When the first post-build engagement reached the attack phase, **both** workload Pods
sat in `ImagePullBackOff`:

1. **target — no certs.d mapping for dynamic engagement registries.** The node's
   containerd resolves a pull ref through the host resolver, **not** cluster DNS, so
   the per-engagement registry Service name `registry.engagement-<id>.svc:5000` did
   not resolve (`dial tcp: lookup … no such host`). M8 node-pull was only ever proven
   against a **hardcoded fixture pool** (`registry.engagement-cap01..cap08.svc`,
   written onto the node by `scripts/m8-proof.sh` via `docker exec $NODE`). The in-pod
   conductor cannot write the node filesystem, so real dynamic engagements never got a
   certs.d entry. This was a latent gap the Kaniko fix unmasked, not a regression.

2. **attacker — harness image ref pointed at a dead private ghcr.** Default
   `conductor/src/autosploit_conductor/k8s/run.py:_DEFAULT_ATTACKER_IMAGE`
   = `ghcr.io/autosploit/harness:dev` → `403 Forbidden`. The node already holds the
   locally-loaded `docker.io/library/harness:h3-local`.

---

## What landed

Two commits on `main`, charts only (no image rebuild):

### `a3e0372` — registry-mapper DaemonSet + harness-image wiring
- **New `registry-mapper` DaemonSet** in the control-plane chart
  (`deploy/helm/control-plane/templates/registry-mapper.yaml`, gated by
  `registryMapper.enabled`, default true). A small reconcile loop (ConfigMap-mounted
  `reconcile.sh`) lists every `registry` Service carrying the `engagement` label
  cluster-wide and keeps
  `/etc/containerd/certs.d/registry.<ns>.svc:5000/hosts.toml` → `http://<ClusterIP>:5000`
  in sync via a hostPath mount, pruning the mapping when the namespace goes away.
  certs.d is read per-pull, so no containerd restart. Read-only RBAC on services; runs
  as root (it writes the node hostPath). Multi-node-correct (one Pod per node),
  decoupled from the conductor. On first start it also cleared the eight stale
  cap01..cap08 fixtures.
- **Harness image at deploy time:** the `conductor.harnessImage` value was already
  wired to `AUTOSPLOIT_HARNESS_IMAGE`; it is now set on the roll
  (`--set conductor.harnessImage=docker.io/library/harness:h3-local`). The engagement
  chart now sets attacker `imagePullPolicy: IfNotPresent` so a node-local harness image
  satisfies the pull.

### `008a243` — registry-mapper image `rancher/kubectl` → `alpine/k8s`
`rancher/kubectl` is a kubectl-only minimal image with **no `/bin/sh`**, so the
DaemonSet's shell reconcile script died with `StartError` (`exec /bin/sh: no such file`).
`alpine/k8s:1.31.0` bundles an Alpine shell + kubectl and runs as root.

Verified: both charts `helm template`/`lint` clean; `reconcile.sh` write+prune logic
unit-tested with a stub kubectl (writes live mappings, prunes stale dirs, hosts.toml
byte-for-byte matches the m8-proof format); `conductor/tests/test_engagement_chart.py`
7 passed.

---

## Deploy state (important for the next session)

- Control-plane at **rev 18**, registry-mapper Pod `Running`, certs.d auto-populates
  on engagement create and auto-prunes on teardown (both observed live).
- **The VPS repo is on branch `h3-contabo-seam1-chart-fixes`, not `main`**, and was
  **not** updated by `git pull`. The control-plane chart on the VPS was synced manually
  this session (scp of `registry-mapper.yaml` + an appended `registryMapper:` block in
  `values.yaml` + a sed swapping the image). So the VPS chart carries the fix but is not
  a clean checkout — a future `git pull`/rebuild onto `main` (which now has both
  commits) should reconcile it. The engagement-chart edit (attacker `imagePullPolicy`)
  rides the **next control-plane image build**, because the engagement chart is baked
  into the fat image at `/app/engagement-chart`, not read from the VPS repo. Harmless
  until then: the `h3-local` tag already defaults to `IfNotPresent`.

### Re-deploy recipe (rev bump)
```bash
helm upgrade control-plane /root/AutoSploit-AI/deploy/helm/control-plane -n autosploit-system \
  --set image.repository=ghcr.io/muditgarg007/control-plane --set image.tag=508c75d \
  --set image.pullPolicy=IfNotPresent \
  --set env.FRONTEND_URL=https://autosploit.muditgarg.xyz \
  --set external.kafkaBrokers="" --set external.schemaRegistryUrl="" \
  --set registryMapper.enabled=true \
  --set conductor.harnessImage=docker.io/library/harness:h3-local \
  --wait --timeout 6m
```

### Verify the attack phase live (burns model credits)
```bash
NS=engagement-<id>
kubectl -n $NS get pods -w          # build→Completed, target→Running, attacker→Running
kubectl -n $NS logs attacker -f     # phase/tool_call/tool_result/cost events
docker exec autosploit-hardening-control-plane ls /etc/containerd/certs.d  # mapping present
kubectl delete ns $NS               # stop it; mapper prunes the certs.d entry within ~10s
```

---

## Still open (carry forward)

- **Attack-phase lifecycle tail** — this session **stopped the engagement right after
  proving the attacker runs and exploits** (deleted the namespace), so the terminal
  path was not watched: does the engagement reach `completed`, write `conductor.json`,
  and tear down cleanly on its own; and does the dashboard detail page render the
  findings/events stream through to the end. The SSE events route is mapped
  (`IngestController /engagements/:id/events POST`) and events were ingesting, so the
  prior "Disconnected" worry looks unfounded — but the full stream to completion is
  still unconfirmed.
- **Stale worker job on a deleted engagement** — the control-plane log repeats
  `engagement a1008402-…: transition … skipped: Illegal state transition: attacking -> …`
  for an engagement whose namespace is long gone. A dead BullMQ job retrying against a
  removed engagement; harmless noise, but worth dead-job pruning / a terminal-state
  guard in `EngagementWorker`.
- **Harness image is a local `h3-local` tag, not a digest-pinned release ref.** The M5
  release pipeline was meant to push a digest-pinned harness; until it does, the attack
  phase depends on the image being present on each node. Fine on single-node kind;
  revisit for multi-node / GKE.
- **#1 Redis not in any manifest** — standing risk. Created imperatively; a node/pod
  wipe drops it and engagements hang at "starting". Restore with
  `kubectl create deployment redis …`.
- **#5 Discovery mis-rejects an immediately-exiting container** — latent provisioner
  bug (`provisioner/.../discovery/ports.py`), `NoPortsExposed` vs `BootTimeout`. Off the
  dashboard path. See project CLAUDE.md.
