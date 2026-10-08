# Handoff — Engagement pipeline stuck ("starting" / "Disconnected")

**Date:** 2026-10-08
**Session owner:** Mudit Garg
**Environment:** Contabo VPS, `ssh root@169.58.86.230`, single-node kind cluster
(`autosploit-hardening-control-plane`), namespace `autosploit-system`.
**Trigger:** New engagement on `MuditGarg007/Autosploit-test` (a deliberately
vulnerable Flask testbed, repo pushed this session) hung at "starting", then the
dashboard showed `undefined` / "Disconnected".

---

## TL;DR

The engagement pipeline has three independent faults, discovered in order:

1. **Redis was missing from the cluster** — queue broker gone, nothing provisioned. **FIXED 2026-10-08.**
2. **The conductor is not packaged in the control-plane image** — `conductor run` cannot execute, so no engagement ever actually runs. **DEPLOYED 2026-10-08 (fourth pass) — Helm rev 11 live; only a live-engagement confirmation remains.** The fat control-plane image bundles the conductor + Python + git/crane/helm + the engagement chart, the worker invokes `conductor run --k8s --target-port`, a `target_port` field flows through the create API → DB → job, and the plane ServiceAccount gets the engagement-ops RBAC. All four commits are on `origin/main` (`4428dbd`); the CI leak scanner was updated for architecture A; the fat GHCR image `:4428dbd` is loaded into the kind node; `OPENROUTER_API_KEY` is in `control-plane-secrets`; the control-plane runs rev 11 with the conductor runnable and `CONDUCTOR_K8S=true`. The first live engagement was triggered (fifth pass): the conductor **did** run end-to-end (record `conductor.json` landed, no `no record; exit=null`), proving the packaging — but provision failed at the git clone because the worker handed the conductor a host-less `owner/repo` ref. **Fixed 2026-10-08 (fifth pass, committed `996069b`) — control-plane fat-image rebuild + redeploy pending.** See fault #6 and the fifth-pass section below.
3. **Frontend routes to `/dashboard/undefined`** and opens the SSE stream with an `undefined` engagement id. **FIXED 2026-10-08 (fifth pass, committed `a2bdf95`) — client redeploy pending.** The client read `row.id` from `POST /engagements`, but that route returns the lifecycle `DispatchResult { engagement, ingestToken }`, not a flat row; the id lives at `row.engagement.id`. See the fifth-pass section below.

Two further issues were surfaced while fixing #2 (see "Issues surfaced 2026-10-08" below):

4. **Provisioner `build/` package was missing** — rebuilt. **FIXED 2026-10-08.** This was the code landmine flagged in `CLAUDE.md` and under #2's "second landmine".
5. **Discovery mis-rejects an immediately-exiting container** (`BootTimeout` vs `NoPortsExposed`) — a latent provisioner bug the #4 fix unmasked. **OPEN.**

Redis was only the first layer. Fixing it unblocked the queue and revealed #2.

---

## 1. Redis missing — FIXED

### Symptom
- Engagement stuck at "starting" with a spinner, forever.
- No `engagement-*` namespace created, no Jobs.
- Control-plane log, repeating ~every 40s:
  `quota meter read failed: Reached the max retries per request limit (which is 20).`

### Root cause
Control-plane expects `redis://redis:6379` (BullMQ job queue + `QuotaService`
meter). There was **no `redis` pod or Service anywhere** in the cluster.

The Helm chart `deploy/helm/control-plane` **intentionally excludes** stateful
dependencies — see the `external:` block in its `values.yaml`:
> "Subcharts for stateful deps are intentionally OUT of scope here — the
> orchestration layer and ops own those (§8.2)."

So Redis was only ever applied imperatively, nothing reconciles it, and the
control-plane restart (Helm rev 10, 2026-10-08 10:29) brought the app back
without Redis. Postgres (`postgres:16-alpine`) and Vault survived as their own
deployments; Redis did not. Last successful engagement (`h3gate`) ran 47h
earlier, while Redis still existed.

### Fix applied
```bash
ssh root@169.58.86.230 'kubectl create deployment redis -n autosploit-system --image=redis:7-alpine \
  && kubectl set resources deploy/redis -n autosploit-system --limits=memory=256Mi --requests=cpu=25m,memory=64Mi \
  && kubectl expose deployment redis -n autosploit-system --port=6379 --target-port=6379 \
  && kubectl rollout status deploy/redis -n autosploit-system --timeout=90s'
```
Verified: `redis` pod Running, Service + endpoint `10.244.0.69:6379` bound,
quota-meter errors stopped within ~20s (ioredis auto-reconnected, no
control-plane restart needed). The worker then began dequeuing engagements.

### Standing risk
This Redis has no persistence and is in **no manifest** — a node/pod wipe drops
it again and engagements silently hang. Proper fix: add Redis (and the other
stateful deps) to a reconciled manifest set owned by ops, instead of imperative
`kubectl`. Documented in auto-memory as `redis-missing-dep-gap.md`.

---

## 2. Conductor not packaged in the control-plane image — OPEN (blocker)

### Symptom
After Redis was fixed, the worker dequeues and logs, for each engagement:
```
engagement <uuid>: spawning conductor for MuditGarg007/Autosploit-test
engagement <uuid>: no record; exit=null
```
No `engagement-*` namespace is created; the engagement never does any work.

### Root cause
`control-plane/src/domains/lifecycle/worker/engagement.worker.ts` shells out to
the conductor as a subprocess (`node:child_process` `spawn`):
- `CONDUCTOR_CMD` default = `conductor` (`src/config/env.service.ts:18`)
- `CONDUCTOR_OUT_DIR` default = `/tmp/autosploit-runs` (`env.service.ts:21`)

Inside the running control-plane pod:
- no `conductor` binary, **no `python`/`python3` at all** — the image is
  node/bun only.
- `/app/packages` contains only `contracts` (no conductor).
- `/tmp/autosploit-runs` does not exist — the conductor has **never run once**.

So `spawn('conductor', …)` fails with ENOENT. The worker's close handler fires
with `exit.code === null`, logs `no record; exit=null`, and derives
failed-internal. The Python Phase-A conductor was simply never built into the
deployed image.

### Second landmine behind it — FIXED 2026-10-08 (see issue #4)
Even once the conductor can execute, there was a known pre-existing gap (was in
`CLAUDE.md` → "Known issues"): `conductor run` → teardown imports
`autosploit_provisioner.build.booter`, but the whole `build/` package did not
exist on disk, raising `ModuleNotFoundError: No module named
'autosploit_provisioner.build'`. **This is now closed** — the `build/` package
was rebuilt from its pinned test contracts; the conductor now imports and runs
the full provision → harness → teardown chain locally. Details under issue #4.
The remaining half of #2 is the image packaging below.

### Three blockers (not just packaging), and the architecture decision — 2026-10-08 (third pass)
Investigating the fix surfaced that packaging alone would not have produced a
working engagement. There were three independent faults on the dashboard →
`POST /engagements` → worker → conductor path:

1. **Wrong phase.** The worker spawned `conductor run <repo>` with **no `--k8s`**,
   i.e. Phase A (local docker). There is no docker socket in the plane pod, and the
   prod model is Phase B (a per-engagement k8s namespace). Packaging the conductor
   would just have changed the failure from ENOENT to "docker not found".
2. **No target port.** The `--k8s` path **requires `--target-port`** (a Dockerfile
   repo does not reliably declare its port, so the operator supplies the scope
   port). There was no target-port concept anywhere in the control-plane API, job
   data, or DB.
3. **No RBAC.** The plane ServiceAccount's ClusterRole had only
   `system:auth-delegator` (Vault). It could not create the namespaces, pods,
   services, secrets, configmaps, or CiliumNetworkPolicies the `--k8s` path needs.

A fourth point is a hardening tradeoff, not a bug: running the conductor in the
plane pod puts `OPENROUTER_API_KEY` into the plane, which the §6 secret split
(SEAM-2) says must never happen. **The owner chose architecture A** (fat image,
conductor in-process in the plane pod) over architecture B (conductor as a
separate per-engagement k8s Job with its own SA/secret), accepting that SEAM-2
relaxation and the broad RBAC on the internet-facing app for the smaller change.
Target port: chosen to flow through the create API (not an env default).

### Fix applied — CODE DONE 2026-10-08 (code in `~/AutoSploit-AI`, no prod poke)
- **Fat image** (`control-plane/Dockerfile`): runtime base flipped to
  `python:3.12-slim` so the conductor's CPython + kubernetes-client TLS work
  natively, with the self-contained `node` binary lifted in from `node:22-slim`.
  Bundles the conductor venv (uv `--no-editable`), `git`, `crane`, `helm`, and the
  per-engagement Helm chart at `/app/engagement-chart` (`AUTOSPLOIT_ENGAGEMENT_CHART`
  defaulted). `conductor` is on PATH; `CONDUCTOR_OUT_DIR` stays `/tmp/autosploit-runs`
  (writable by the non-root user). `.dockerignore` now re-includes
  `deploy/helm/engagement`.
- **Target port through the API**: `target_port` column (migration
  `0004_complex_swarm.sql`, additive nullable integer), optional `targetPort` on
  `CreateEngagementDto` (validated 1–65535), persisted and carried on
  `EngagementJobData`.
- **Worker** (`engagement.worker.ts`): appends `--k8s --target-port <p>` when
  `CONDUCTOR_K8S=true`, port = the engagement's `targetPort` ?? `conductorDefaultTargetPort`.
  New env (`env.service.ts`): `conductorK8s` (default **false** so dev/tests keep
  Phase A), `conductorDefaultTargetPort` (5000).
- **Conductor CLI** (`cli.py`): added `--traceparent` (accepted, inert). The worker
  always passed it, which would have crashed the conductor's argparse the instant it
  actually ran — a latent bug unmasked by making the conductor runnable.
- **Helm**: `conductor.*` and `rbac.engagementOps` values; deployment env
  (`CONDUCTOR_K8S`, `CONDUCTOR_DEFAULT_TARGET_PORT`, `CONDUCTOR_TIMEOUT_S`,
  `CONDUCTOR_OUT_DIR`, `AUTOSPLOIT_ENGAGEMENT_CHART`, optional `AUTOSPLOIT_HARNESS_IMAGE`,
  and `OPENROUTER_API_KEY` via `secretKeyRef` optional); an engagement-ops ClusterRole
  + binding (namespaces / pods / pods/log / services / secrets / configmaps +
  `cilium.io` ciliumnetworkpolicies).

Verified locally: control-plane `nest build` green; conductor CLI tests 15 passed
(the full `run … --k8s --target-port … --traceparent …` argv parses); `helm template`
renders the new env + ClusterRole; control-plane `vitest` 70 passed including
`lifecycle.spec` against a real Postgres with migration 0004 (one unrelated flake:
`telemetry-durable.spec` Postgres `57P01` container-teardown race, in untouched code).
Built the image as `control-plane:eng2` (2.23 GB) and smoke-tested it: node 22,
python 3.12, `conductor` on PATH and runnable, git + crane + helm 3.16.2, the chart,
and the whole `--k8s` import chain (kubernetes 36.0.3 + conductor k8s modules +
provisioner build) all load as the non-root `autosploit` user.

### Deploy steps — DONE 2026-10-08 (fourth pass), except the final live run

All four commits landed on `origin/main` and the prod box was rolled forward to
Helm rev 11. Sequence as executed:

0. **Committed + pushed.** Four commits: `fix(control-plane): treat Transit
   key-create 403 as benign at boot` (pre-existing), `fix(provisioner): restore
   build/ package and stop gitignoring it`, `feat(control-plane): run the conductor
   in-process via a fat image (arch A)`, `test(control-plane): update secret-split
   leak scanner for architecture A`. Pushed `1a71877..4428dbd` to `origin/main`
   (triggered CI + Release).
1. **CI leak scanner updated — DONE.** `control-plane/test/leak-scanner.spec.ts`
   was reframed for architecture A: it no longer asserts "key never enters the
   plane" (that invariant was deliberately relaxed), and it had a real gap — it only
   walked `control-plane/`, so it never actually covered the chart it claimed to
   guard. New assertions: no key VALUE (`sk-or-v1-…`) in plane source, config, OR
   the chart; the plane application code never reads the key
   (`process.env.OPENROUTER_API_KEY`); the chart references it ONLY via
   `secretKeyRef`. Scanner now walks both `control-plane/` and
   `deploy/helm/control-plane/`. 4 tests pass. (The release-workflow image scan
   greps the key VALUE shape and passed on the fat image.)
2. **`OPENROUTER_API_KEY` added to `control-plane-secrets` — DONE** (merge-patched
   `stringData`, the other 7 keys preserved; present, not decoded).
3. **Fat image built + loaded + Helm rev bump — DONE.** Release CI built and pushed
   the multi-arch `ghcr.io/muditgarg007/control-plane:4428dbd6…` (amd64 build +
   leak scan + multi-arch push all green). On the VPS the image was loaded into the
   kind node (see the kind gotcha below) as `:4428dbd`, and `helm upgrade` ran to
   rev 11 with the rev-10 user values re-supplied explicitly (NOT `--reuse-values`
   — that flag ignores the new chart's `conductor.*` / `rbac.engagementOps`
   defaults and would break template rendering) plus `image.tag=4428dbd`. The
   pre-upgrade migrate-job applied migration 0004. Verified in the running pod:
   image `:4428dbd`, `conductor` runnable (`/app/conductor/.venv/bin/conductor`,
   first on the container PATH node inherits), `CONDUCTOR_K8S=true`, all conductor
   env + `OPENROUTER_API_KEY` present, engagement-ops ClusterRole + binding
   rendered, chart at `/app/engagement-chart`.
4. **Re-run an engagement — PENDING (the only remaining item).** Trigger one
   engagement (dashboard against `MuditGarg007/Autosploit-test`, target port 5000)
   and confirm the worker logs `spawning conductor` without the follow-up
   `no record; exit=null`, a new `engagement-*` namespace appears, and
   `conductor.json` lands under `CONDUCTOR_OUT_DIR/<id>/` (`/tmp/autosploit-runs`).

#### kind multi-arch load gotcha (worth remembering)
`kind load docker-image` and `kind load image-archive` both import with
`--all-platforms`. A `docker pull` of the multi-arch tag fetches only the host
(amd64) variant, so the image/tar still carries the manifest-list **index**
referencing the absent arm64 manifest, and the load fails with
`ctr: content digest sha256:…: not found`. Fix (matches the operator's earlier
`@sha256:` digest-pinned images): resolve the amd64 platform digest with
`docker manifest inspect`, `docker pull` that digest (a single-platform image, no
index), retag to the short tag, `docker save`, then `kind load image-archive`.

### Open question — ANSWERED 2026-10-08 (owner)
How did `h3gate` run 47h ago if the conductor was never in the image? `h3gate`
was the red-team §7 flow, closed successfully — a different path, not the
dashboard → `POST /engagements` → worker path. The engagement now being verified
is the **first** exercise of the dashboard engagement path, so treat step-4
surprises as first-run issues, not regressions.

---

## 3. Frontend routes to `/dashboard/undefined` — OPEN (cosmetic vs. #2)

### Symptom
Dashboard shows title `undefined`, URL `…/dashboard/undefined`, status
"Disconnected". Control-plane logs the only level-50 errors as:
```
invalid input syntax for type uuid: "undefined"
  at LifecycleService.assertOwned (…/lifecycle.service.js:135)
  at SseController.stream (…/sse/sse.controller.js:33)
```

### Root cause
The engagement **is** created server-side (rows `b4ed4474-1f08-44e6-b3bb-94098ed677a7`
and `f4716c87-254a-45bb-b366-f5eb8f5d9565` exist). The frontend navigates to the
detail route and opens the SSE stream `GET /engagements/:id/stream` with `id`
literally `undefined` — it is not reading the created engagement's `id` out of
the `POST /engagements` response (or the route param is lost on redirect).

### Fix
Frontend: after `POST /engagements`, use the returned `id` to build the detail
route and the SSE URL. Backend is fine (it correctly rejects a non-UUID id).

---

---

## Issues surfaced 2026-10-08 (while fixing #2)

### 4. Provisioner `build/` package was missing — FIXED

#### Root cause
`provisioner/src/autosploit_provisioner/teardown/teardown.py` (and `provision.py`)
import `ENGAGEMENT_LABEL` / `boot` / `run_image` / `resolve_build` from
`autosploit_provisioner.build.*`, but the whole `build/` package was absent from
disk — never committed (not in git history). Importing the provisioner
`teardown`/`run` therefore raised `ModuleNotFoundError: No module named
'autosploit_provisioner.build'`, which (a) broke collection of three conductor
test files and (b) is the "second landmine" that would have killed any real
conductor run at teardown.

Root cause for the never-committed part (found fourth pass): `provisioner/.gitignore`
had an unanchored `build/` rule (meant for the setuptools artifact dir) that also
matched the `src/autosploit_provisioner/build/` source package, so it could never
be `git add`ed. Fixed by anchoring the rule to `/build/`; the source package is
now tracked.

#### Fix applied (code in `~/AutoSploit-AI`, no prod poke)
Rebuilt the package from its pinned test contracts:
- `build/resolver.py` — `resolve_build(workdir) -> BuildPlan` with the §8 reject
  ladder: a real `Dockerfile` wins; compose-only → `UnsupportedBuild("compose
  deferred, Dockerfile only for MVP")`; neither → `UnsupportedBuild("no
  Dockerfile; nothing to build")`.
- `build/booter.py` — `ENGAGEMENT_LABEL = "engagement"`; `boot(plan, tag,
  engagement_id)` runs `docker build` then `docker run -d -P --label
  engagement=<id>`, raising `BuildFailed` (with a `.log_tail`) on a build failure
  and leaving no orphan container; `run_image(image_ref, engagement_id)` is the
  image-source shortcut (no build, just the labeled run).
- `build/__init__.py` — re-exports the four names.

Also reverted the earlier lazy-import mitigation in
`conductor/src/autosploit_conductor/cli.py`: now that the root cause is gone,
`run` is imported at module top level again (`from autosploit_conductor.run
import run`), which restores the module-level `cli.run` seam the CLI tests patch.

#### Verified
- Provisioner: 41 unit tests pass; `test_booter.py` + `test_resolver.py` 12
  integration tests pass against a real Docker daemon (build + run + label; broken
  Dockerfile → `BuildFailed` with log tail, no orphan).
- Conductor: the three previously-uncollectable files now pass (16 tests,
  including the 4 CLI `run`-patch tests); non-integration suite 167 passed, 2
  skipped.

Nothing committed yet — left for review.

### 5. Discovery mis-rejects an immediately-exiting container — OPEN

#### Symptom
`provisioner/.../discovery/ports.py::discover` raises `NoPortsExposed` for a
container that exits immediately with no exposed ports, when the intended reject
is `BootTimeout` (with the container-log tail, §8). Reproduces **consistently**
(not flaky) via
`provisioner/tests/test_discovery.py::test_container_exits_immediately_rejects_boottimeout`
(`CMD ["sh","-c","echo boom; exit 1"]`) — currently the one failing provisioner
test.

#### Root cause
`discover`'s first poll can catch the container while still `Status == running`,
read an empty port map, and immediately reject `NoPortsExposed` — before the
container reaches its terminal (`exited`) state that would route it to
`BootTimeout`. The sibling test `test_exposeless_image_rejects_no_ports`
(`CMD ["sleep","60"]` — stays up, no ports → `NoPortsExposed`) passes, so the fix
cannot simply reclassify: it must distinguish "ready and *stably* running with no
ports" from "running only momentarily, about to exit." Suggested fix: give a
port-less `running` container a brief grace/confirmation poll before rejecting as
`NoPortsExposed`, and let a container that reaches a terminal state within that
window fall through to `BootTimeout`.

#### Note
This is a **latent** provisioner bug, not a regression: both discovery tests are
integration and only became runnable once the `build/` package (#4) was restored.
The booter is not implicated — a no-`EXPOSE` container has no ports regardless,
and it exits on its own.

### 6. Worker hands the conductor a host-less repo ref — FIXED (fifth pass)

#### Symptom
The first live dashboard engagement (`ab35d906-874a-4bd2-920d-60104d375ed9`) ran
the conductor to completion — `/tmp/autosploit-runs/<id>/conductor.json` was
written, no `no record; exit=null` — but the record showed provision failed:
```
"provision": {
  "error": "build-context preparation failed: git clone failed: ... unable to
   access 'https://MuditGarg007/Autosploit-test/': Could not resolve host:
   MuditGarg007",
  "ok": false
}
```

#### Root cause
The worker invokes `conductor run <repoRef>` with the GitHub fullName
`owner/repo`. The conductor's clone convention (k8s `provision.py::_clone_ref`)
is a bare `host/org/repo`, which it turns into an `https://` remote. A
two-segment `owner/repo` therefore became `https://owner/repo` with `owner`
parsed as the DNS host — `MuditGarg007` — and the clone failed to resolve.
`h3gate` never hit this: it was the red-team flow, not the dashboard →
`POST /engagements` → worker → conductor path, which this engagement exercised
for the first time.

#### Fix applied (committed `996069b`, code only)
`engagement.worker.ts` now runs the ref through `conductorRepoRef()` for the
conductor argv only: a bare `owner/repo` is qualified to `github.com/owner/repo`
(the control plane is GitHub-only — GitHub OAuth, GitHub tokens), while a ref
that already carries a scheme, an scp-like remote, or a host segment passes
through. The job's `repoRef` (DB row, logs, `conductor.json` `repo_ref`) stays
the clean fullName. `GITHUB_TOKEN` is already in the conductor env, so the
provisioner cloner authenticates private repos once the host resolves. Covered
by `control-plane/test/conductor-repo-ref.spec.ts` (5 cases). Verified that
`github.com/MuditGarg007/Autosploit-test` resolves and clones (the repo is
public).

#### Remaining
Rebuild + reload the fat control-plane image and roll the Helm release so the
worker fix is live, then re-run. The next unknown is the Kaniko in-cluster build
and the attack phase — still unexercised by the dashboard path.

---

## Quick diagnostic reference (next time an engagement hangs)

```bash
# 1. Did it provision?
kubectl get ns | grep engagement            # no new engagement-* = never provisioned

# 2. Is Redis alive?  (fault #1)
kubectl get pods,svc -n autosploit-system | grep -i redis

# 3. Control-plane tells which stage failed:
kubectl logs -n autosploit-system deploy/control-plane-control-plane-app --since=15m \
  | grep -iE "quota meter|spawning conductor|no record|uuid"
#   "quota meter ... max retries"      -> Redis down (#1)
#   "spawning conductor ... no record" -> conductor can't run (#2)
#   'uuid "undefined"'                 -> frontend id bug (#3)

# 4. Is the conductor even in the image?  (fault #2)
P=$(kubectl get pod -n autosploit-system -o name | grep control-plane-app | head -1)
kubectl exec -n autosploit-system $P -- sh -lc 'which conductor python3; ls /tmp/autosploit-runs'
```

## Engagement DB note
The engagements table column is `state`, **not** `status`:
```sql
SELECT id, repo_full_name, state, created_at FROM engagements ORDER BY created_at DESC LIMIT 5;
```

## Cleanup
The two failed engagements from this session (`b4ed4474…`, `f4716c87…`) will not
self-recover; abort/ignore them and start fresh once #2 is fixed.

---

## State at end of session

### 2026-10-08 (first pass)
- Redis: **running and healthy** (manual, non-persistent).
- Conductor packaging: **unaddressed** — top priority, blocks all engagements.
- Frontend id bug: **unaddressed**.
- Test target repo `MuditGarg007/Autosploit-test`: pushed, Dockerfile added,
  deployable; 13 intentional vulns catalogued in that repo's `VULNS.md`.

### 2026-10-08 (second pass — provisioner build gap)
- Provisioner `build/` package (#4): **rebuilt and verified** locally; conductor
  now runs the full chain. Not committed.
- Conductor packaging into the control-plane image (the remaining half of #2):
  **still unaddressed** — this is the real prod blocker now. The image is still
  node/bun only; the conductor code being runnable locally does not put it in the
  deployed image.
- Discovery `BootTimeout` race (#5): **open** — one failing provisioner
  integration test, documented above.
- Frontend id bug (#3): **unaddressed**.
- `CLAUDE.md` "Known issues": updated (build gap moved to Resolved; discovery race
  added).

### 2026-10-08 (third pass — #2 code done, architecture A)
- Conductor packaging + k8s wiring (#2): **CODE DONE, deploy remaining.** Chose
  architecture A (conductor in-process in the plane pod via a fat image). Landed
  the fat `control-plane/Dockerfile`, the `target_port` API→DB→job→worker path
  (migration 0004), the worker `--k8s --target-port` invocation, the `--traceparent`
  CLI fix, and the Helm env + engagement-ops RBAC. Built + smoke-tested the image
  (`control-plane:eng2`). All local checks green (nest build, conductor CLI,
  helm template, vitest 70 inc. lifecycle on a real DB). **Not committed.**
  **Deploy not done:** CI leak scanner must be updated (will fail under arch A),
  `OPENROUTER_API_KEY` added to the plane Secret, image pushed/loaded, Helm rev
  bumped `conductor.k8s=true`, and an engagement re-run to confirm the namespace +
  record. See §2 "Deploy steps remaining".
- Discovery `BootTimeout` race (#5): **still open**.
- Frontend id bug (#3): **still unaddressed**.
- `CLAUDE.md` "Resolved": #2 code work added; auto-memory `conductor-in-plane-image.md`
  written.

### 2026-10-08 (fourth pass — #2 committed + deployed, Helm rev 11)
- Conductor packaging + k8s wiring (#2): **DEPLOYED.** Committed the third-pass
  code as 4 commits and pushed `1a71877..4428dbd` to `origin/main`. Updated the CI
  leak scanner (`leak-scanner.spec.ts`) for architecture A and closed its chart
  coverage gap (4 tests pass). Release CI built + pushed the multi-arch fat image
  `:4428dbd6…`; loaded it into the kind node as `:4428dbd` via the amd64-digest →
  save → `image-archive` route (see the kind multi-arch gotcha in §2); added
  `OPENROUTER_API_KEY` to `control-plane-secrets`; `helm upgrade` to **rev 11** with
  the rev-10 user values re-supplied explicitly + `image.tag=4428dbd` (migrate-job
  applied 0004). Verified in-pod: `:4428dbd` image, conductor runnable,
  `CONDUCTOR_K8S=true`, OPENROUTER key + conductor env present, engagement-ops RBAC
  rendered.
- Provisioner `build/` gitignore (#4 follow-up): fixed the unanchored `build/`
  rule that had kept the source package out of git (`/build/` now); package tracked.
- **The ONLY remaining item for #2:** trigger one engagement and confirm the
  `engagement-*` namespace + `conductor.json` (step 4 in §2). The dashboard path is
  being exercised for the FIRST time (h3gate was the red-team flow — see the
  answered open question), so treat first-run breakage as new, not regression.
- Discovery `BootTimeout` race (#5): **still open**.
- Frontend id bug (#3): **still unaddressed** — this is the visible "Disconnected"
  the user sees even on a successful backend run.
- Standing Redis risk (#1): **still not in any manifest** — a node/pod wipe drops it.

### 2026-10-08 (fifth pass — first live engagement run; #3 and new #6 fixed)
- Triggered the first engagement over the real dashboard →
  `POST /engagements` → worker → conductor path
  (`ab35d906-874a-4bd2-920d-60104d375ed9`, `MuditGarg007/Autosploit-test`).
- **#2 packaging proven:** the conductor ran end-to-end inside the plane pod
  (`conductor.json` written under `/tmp/autosploit-runs/<id>/`, worker logged
  `spawning conductor` with no `no record; exit=null` follow-up). The fat image
  + arch-A wiring works.
- **#6 (new fault) — FIXED, committed `996069b`:** provision failed at the git
  clone because the worker passed a host-less `owner/repo`; the conductor's
  `_clone_ref` made it `https://owner/repo`. `conductorRepoRef()` now qualifies a
  bare GitHub `owner/repo` to `github.com/owner/repo` at the conductor argv.
  `nest build` green; new spec `conductor-repo-ref.spec.ts` 5 passed; the
  qualified URL verified to resolve + clone (public repo). **control-plane
  fat-image rebuild + Helm roll pending** before it is live.
- **#3 — FIXED, committed `a2bdf95`:** the client read `row.id` from
  `POST /engagements`, but that returns `DispatchResult { engagement, ingestToken
  }`; the id is at `row.engagement.id`. `createEngagement` now reads it, so the
  new run routes to the real id instead of `/dashboard/undefined`. **client
  redeploy pending.**
- Both fixes are code-only, pushed to `origin/main` (`4428dbd..996069b`); nothing
  on prod yet. NOTE: the working tree also carries an unrelated, in-progress
  client UI refactor (`SignInCard`/`SignInModal`/`NewEngagementPanel`, a deleted
  `NewEngagementForm`/`new` page, Navbar/Sidebar/CTA, icon/favicon) that was
  **deliberately left uncommitted** — not part of these two fixes.
- **Next:** (1) redeploy the client (fixes the visible "Disconnected"); (2)
  rebuild + reload the fat control-plane image via the amd64-digest →
  `image-archive` route (§2 kind gotcha) and Helm-roll it (fixes the clone); (3)
  re-run one engagement — the clone will succeed, and the first-exercise unknowns
  move to the Kaniko in-cluster build + the attack phase.
- Discovery `BootTimeout` race (#5): **still open.**
- Standing Redis risk (#1): **still not in any manifest.**
