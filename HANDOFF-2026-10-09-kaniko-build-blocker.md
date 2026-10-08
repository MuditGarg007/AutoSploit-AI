# Handoff — engagement reaches Kaniko build, fails there

**Date:** 2026-10-09
**Session owner:** Mudit Garg
**Environment:** Contabo VPS, `ssh root@169.58.86.230`, single-node kind cluster
(`autosploit-hardening`, control-plane node `autosploit-hardening-control-plane`),
namespace `autosploit-system`.
**Repo:** `origin/main` at `d3f4b44`. Frontend on Vercel (git-connected, auto-deploys
`main`); backend on the VPS via Helm (manual rolls).

---

## TL;DR

The dashboard engagement pipeline now runs end to end through every previously
broken stage and dies at a new one: the in-cluster Kaniko build.

A real engagement (`a5edbb0e-5187-46b6-958d-581d5a3b2dee`,
`MuditGarg007/Autosploit-test`, target port 5000) was launched from the live
dashboard this session and got: auth -> create -> worker dequeue -> conductor
spawn (in-process) -> git clone -> per-engagement namespace + registry -> Kaniko
build **FAIL**. It never reached the attack phase.

`conductor.json` for that run:
```json
{
  "engagement_id": "a5edbb0e-5187-46b6-958d-581d5a3b2dee",
  "repo_ref": "github.com/MuditGarg007/Autosploit-test",
  "provision": { "error": "kaniko build failed (phase=Failed, exit=100)", "ok": false },
  "harness": null,
  "report_path": null,
  "status": null
}
```

Three prior faults are now confirmed FIXED and live (see "Confirmed fixed" below):
conductor packaging in the plane image (#2), the host-less repo ref (#6), and the
frontend `undefined` id (#3).

**The one remaining pipeline blocker is the Kaniko build (`exit=100`).** The actual
build error is not recorded anywhere, because the conductor raises on a failed build
without ever fetching the build pod's logs, and teardown then deletes the namespace.
Fixing the diagnosis gap is the first task; the root cause is almost certainly the
build needing network egress that the engagement's default-deny NetworkPolicy
denies (hypothesis below).

---

## Current deployed state (what is live right now)

- **Frontend (Vercel):** Production deployment of `d3f4b44` succeeded. The detail
  route uses the real engagement id (no more `/dashboard/undefined`). No action
  pending.
- **Control-plane (Helm):** revision **12**, image
  `ghcr.io/muditgarg007/control-plane:996069b` loaded into the kind node. The pod
  runs the fat image: `conductor` resolvable (runtime `PATH` leads with
  `/app/conductor/.venv/bin`), `CONDUCTOR_K8S=true`, default target port 5000,
  engagement-ops RBAC present. This carries the #6 clone fix.
- **Redis:** running, but still created imperatively and in **no manifest** — a
  node/pod wipe drops it and engagements silently hang at "starting". See "Standing
  risks".
- **Test target repo:** `MuditGarg007/Autosploit-test` (public), Flask testbed with
  a Dockerfile, 13 intentional vulns in its `VULNS.md`. Scope/target port 5000.

### Working tree caution
The working tree carries an **uncommitted, in-progress client UI refactor**
(`client/components/SignInCard.tsx`, `SignInModal.tsx`,
`dashboard/NewEngagementPanel.tsx`, a deleted `NewEngagementForm.tsx` + `new/page.tsx`,
and edits to `Navbar`/`Sidebar`/`CTA`/`DashboardShell`/`page.tsx`/icons). It is
unrelated to the pipeline fixes and was deliberately left uncommitted. Do not commit
or clobber it without checking with the owner.

---

## THE BLOCKER: Kaniko build fails (`phase=Failed, exit=100`)

### What we know
- `exit=100` is Kaniko's generic "build command failed" exit, i.e. Kaniko started
  and the build itself errored — this is **not** an image-pull/scheduling failure
  (that would surface as `ImagePullBackOff`/Pending, not a Failed pod with exit 100).
- The build pod (`build`) and the per-engagement `registry` pod both reached
  `Running` in `engagement-a5edbb0e-…`; `build` then went to `Error` ~2 min in.
- The clone succeeded (`repo_ref` is the host-qualified `github.com/…` form and
  provision got past clone/mirror all the way to the build), so #6 is not implicated.

### Diagnosis gap to close FIRST (small, high-value code fix)
The real Kaniko stderr is thrown away today:

- `conductor/src/autosploit_conductor/k8s/provision.py:168-171` raises
  `ProvisionError(f"kaniko build failed (phase={outcome.phase}, exit={outcome.exit_code})")`
  **without** reading the build pod's logs.
- A log-fetch wrapper already exists:
  `conductor/src/autosploit_conductor/k8s/client.py:234` `pod_logs(name)` ->
  `read_namespaced_pod_log`. It is just never called on the build-failure path.
- On that raise, teardown runs in `finally` and deletes the namespace
  (`client.py:111` `delete_namespace`), so the build pod and its logs are gone by the
  time anyone looks (confirmed: the namespace was already `NotFound` seconds after
  the failure this session).

**Fix:** in `provision.py`, when `outcome.phase != "Succeeded"`, fetch
`cluster.pod_logs(m.BUILD_POD_NAME)` and append a bounded tail to the `ProvisionError`
message — mirroring the §8 container-log-tail pattern the provisioner already uses for
`BootTimeout`. Then every future failed build records its real cause in
`conductor.json`. Cover it in `conductor/tests/test_k8s_provision.py` (there is
already a `test_...match="kaniko build failed"` case at line ~261 to extend).

### To get THIS run's cause before that fix lands
Re-run one engagement and capture the build log before teardown wins the race:
```bash
# as soon as the namespace appears:
NS=$(ssh root@169.58.86.230 'kubectl get ns -o name | grep engagement- | tail -1')
ssh root@169.58.86.230 "kubectl logs -f build -n ${NS##*/}"   # follow until it dies
```
Teardown is quick on failure, so either stream with `-f` the instant the ns appears,
or temporarily neutralize teardown for one run (e.g. comment the `delete_namespace`
call / out-dir removal) to inspect the pod at leisure. Remember to restore it.

### Most likely root cause (hypothesis to test)
The build runs under the M7 **default-deny egress** NetworkPolicy. The conductor
feeds Kaniko a self-contained context: build context from an in-cluster ConfigMap
(`--context=dir://…` with `context_configmap`) and external `FROM` bases resolved
through the preloaded in-cluster mirror
(`--registry-mirror`, `--insecure-pull`, `--skip-default-registry-fallback`), so
base pulls need no internet. See `kaniko_build_pod_manifest`
(`conductor/src/autosploit_conductor/k8s/manifests.py:311-410`).

But a `RUN` step inside the **target repo's Dockerfile** that needs the internet
(`pip install -r requirements.txt`, `apt-get`, `npm install`, …) has no egress and
Kaniko exits 100. The `Autosploit-test` Flask Dockerfile very plausibly does a
`RUN pip install`. If so, this is the cause.

Resolution options, in order of least surprise:
1. Make the testbed image self-contained: deps vendored, or a base image that already
   carries them, so no `RUN` needs network. Fix in the `Autosploit-test` repo, not here.
2. Use an image source (prebuilt `image://…`) instead of a Dockerfile build for repos
   whose build needs network — the provision `dir://` passthrough / `run_image`
   shortcut exists for exactly the no-build case.
3. Only if the product must support network-building repos: give the build pod scoped
   egress (e.g. PyPI) — this widens the M7 matrix and needs the owner's sign-off; it
   is the least preferred path.

Confirm which with the captured Kaniko log before choosing. Other, lower-probability
causes the log will rule in/out: the context ConfigMap hitting the ~1 MiB limit for a
large repo (would more likely raise earlier, in `create_build_context_configmap`), or
a Dockerfile not at the expected path (`DEFAULT_DOCKERFILE`).

---

## Confirmed fixed and live this session

- **#2 conductor packaging (arch A fat image).** Worker logged
  `spawning conductor for MuditGarg007/Autosploit-test` with **no**
  `no record; exit=null` follow-up; `conductor.json` was written; the per-engagement
  namespace, registry, and build pod were all created. The conductor runs in-process
  in the plane pod.
- **#6 host-less repo ref.** `conductor.json` `repo_ref` is
  `github.com/MuditGarg007/Autosploit-test` and the clone succeeded (provision got to
  the build). Live via image `:996069b` (commit `996069b`).
- **#3 frontend `undefined` id.** The detail route opened at
  `/dashboard/a5edbb0e-5187-46b6-958d-581d5a3b2dee` (real UUID), not
  `/dashboard/undefined`. Live via Vercel `d3f4b44` (commit `a2bdf95`).

---

## Other open issues (carry forward)

### SSE "Disconnected" on the detail page — unconfirmed, watch
The detail page showed the status badge "Disconnected" with 0 stream events while the
run was alive. This run failed fast at provision (before any attack-phase events are
emitted), so "Disconnected / 0 events" may simply be "nothing streamed yet", not a
bug. Re-evaluate once an engagement actually reaches the attack phase and emits
events. If it is still Disconnected then, look at the SSE auth path (the access token
rides as a `?access_token=` query param because `EventSource` cannot set headers;
`session.guard.ts` accepts the query fallback) and CORS on
`GET /engagements/:id/stream`.

### #5 Discovery mis-rejects an immediately-exiting container — OPEN (latent, local)
`provisioner/.../discovery/ports.py::discover` can raise `NoPortsExposed` for a
container that exits immediately with no ports, when the intended reject is
`BootTimeout` (with the container-log tail, §8). Reproduces consistently via
`provisioner/tests/test_discovery.py::test_container_exits_immediately_rejects_boottimeout`.
Fix: give a port-less `running` container a brief grace/confirmation poll before
rejecting `NoPortsExposed`, and let a container that reaches a terminal state in that
window fall through to `BootTimeout`. Latent provisioner bug, not on the dashboard
path; the one failing provisioner integration test.

### #1 Redis not in any manifest — standing risk
Redis is created imperatively (`kubectl create deployment redis …`) and is in no
Helm chart (the control-plane chart intentionally excludes stateful deps). A node/pod
wipe drops it; engagements then hang at "starting" and the control-plane log repeats
`quota meter read failed: Reached the max retries per request limit`. Proper fix: a
reconciled manifest set for Redis (and the other stateful deps) owned by ops. To
restore in a pinch:
```bash
ssh root@169.58.86.230 'kubectl create deployment redis -n autosploit-system --image=redis:7-alpine \
  && kubectl set resources deploy/redis -n autosploit-system --limits=memory=256Mi --requests=cpu=25m,memory=64Mi \
  && kubectl expose deployment redis -n autosploit-system --port=6379 --target-port=6379 \
  && kubectl rollout status deploy/redis -n autosploit-system --timeout=90s'
```

---

## Reference

### Trigger an engagement (operator, via the live dashboard)
Sign-in is GitHub OAuth and must be done by the operator in a browser (credentials /
OAuth grant). Open `https://autosploit.muditgarg.xyz/dashboard`, sign in with GitHub,
"New engagement", repo `MuditGarg007/Autosploit-test`, target port `5000`, submit.

### Quick diagnostics (next time an engagement fails)
```bash
# Which stage? control-plane worker log:
ssh root@169.58.86.230 'kubectl logs -n autosploit-system deploy/control-plane-control-plane-app --since=15m \
  | grep -iE "quota meter|spawning conductor|no record|uuid"'
#   "quota meter ... max retries"      -> Redis down (#1)
#   "spawning conductor ... no record" -> conductor cannot run (#2, regressed)
#   'uuid "undefined"'                 -> frontend id bug (#3, regressed)

# Did it provision? (namespace is short-lived on failure — teardown deletes it)
ssh root@169.58.86.230 'kubectl get ns | grep engagement-'

# The conductor record (survives teardown; out-dir is /tmp/autosploit-runs/<id>/):
P=control-plane-control-plane-app   # a deploy; resolve the pod with: kubectl get pod -n autosploit-system | grep app
ssh root@169.58.86.230 "kubectl exec -n autosploit-system deploy/$P-control-plane-app -- cat /tmp/autosploit-runs/<id>/conductor.json"
```
Note: the engagements table column is `state`, not `status`.

### Re-deploying the control-plane image (the kind multi-arch load gotcha)
Release CI (`.github/workflows/release.yml`, runs on push to `main`) builds and pushes
the multi-arch `ghcr.io/muditgarg007/control-plane:<full-sha>` + `:latest`. There is
**no deploy job** — the VPS roll is manual. `kind load` imports `--all-platforms`, so a
plain `docker pull` of the multi-arch tag (host arch only) leaves the manifest-list
index referencing an absent arm64 manifest and the load fails
(`ctr: content digest …: not found`). Route that works (used for `:996069b` this
session):
```bash
SHA=<full git sha>; SHORT=<short sha>; REPO=ghcr.io/muditgarg007/control-plane
AMD=$(docker manifest inspect $REPO:$SHA | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest')
docker pull $REPO@$AMD
docker tag  $REPO@$AMD $REPO:$SHORT
docker save $REPO:$SHORT -o /tmp/cp-$SHORT.tar
kind load image-archive /tmp/cp-$SHORT.tar --name autosploit-hardening
```
Then Helm (re-supply the rev user values explicitly — do **not** `--reuse-values`, it
drops the chart's `conductor.*` / `rbac.engagementOps` defaults):
```bash
ssh root@169.58.86.230 'helm upgrade control-plane /root/AutoSploit-AI/deploy/helm/control-plane -n autosploit-system \
  --set image.repository=ghcr.io/muditgarg007/control-plane \
  --set image.tag=<SHORT> \
  --set image.pullPolicy=IfNotPresent \
  --set env.FRONTEND_URL=https://autosploit.muditgarg.xyz \
  --set external.kafkaBrokers="" \
  --set external.schemaRegistryUrl="" \
  --wait --timeout 6m'
```
The chart on the box is `/root/AutoSploit-AI/deploy/helm/control-plane`
(at `4428dbd`; the chart is unchanged since then, so it matches HEAD). Chart defaults
`conductor.k8s=true` and `rbac.engagementOps=true` live in
`deploy/helm/control-plane/values.yaml`.

### Key file pointers
- Kaniko failure raise (no log capture): `conductor/src/autosploit_conductor/k8s/provision.py:150-173`
- Build-pod log fetch wrapper (exists, unused on failure): `conductor/src/autosploit_conductor/k8s/client.py:234` `pod_logs`
- Kaniko pod manifest + args: `conductor/src/autosploit_conductor/k8s/manifests.py:311-410`
- Namespace teardown: `conductor/src/autosploit_conductor/k8s/client.py:111` `delete_namespace`
- Build concurrency gate (fail-open, Redis): `conductor/src/autosploit_conductor/k8s/build_gate.py`
- Worker spawn + argv: `control-plane/src/domains/lifecycle/worker/engagement.worker.ts`
