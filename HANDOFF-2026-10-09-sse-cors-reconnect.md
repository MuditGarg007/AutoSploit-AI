# Handoff — SSE CORS fixed (dashboard live); full attack-phase lifecycle tail proven; rev 20 deployed

**For:** next Claude Code session. Dense on purpose. All file:line / commands / exact strings are load-bearing.
**Date:** 2026-10-09 (resolved 2026-10-10). Continues the earlier SSE/reconnect handoff.
**Env:** Contabo VPS `ssh root@169.58.86.230`, single-node kind cluster `autosploit-hardening`
(node `autosploit-hardening-control-plane`), namespace `autosploit-system`.
**Repo:** `origin/main` @ `7a380a0`. Frontend on Vercel (git-connected, auto-deploys `main`).
Backend on VPS via Helm, **control-plane rev 20**, image `ghcr.io/muditgarg007/control-plane:7a380a0`.
VPS repo on `main`.

---

## RESOLVED this session

### Follow-up session 2026-10-10 (continued) — two carry-forward items closed in code

Both landed on `main` (working tree, **uncommitted + undeployed** as of this write). No deploy yet;
see each item's deploy note. `nest build` green, targeted tests green.

- **#1 Redis durable manifest.** Redis was imperative-only, so a node/pod wipe dropped it and
  engagements hung at "starting" (quota-meter log the tell). New declarative ops manifest
  `deploy/vps/deps-redis.yaml` (Deployment + Service `redis:6379`, `redis:7-alpine`, non-persistent
  by design — `--save "" --appendonly no`, parity with the old imperative setup; readiness
  `redis-cli ping`). NOT part of the Helm release (so `helm upgrade` never drifts it). Runbook §5.3
  points at it. YAML + `kubectl apply --dry-run=client` validated locally.
  **Deploy:** `ssh root@169.58.86.230 'cd /root/AutoSploit-AI && git pull --ff-only && kubectl apply -f deploy/vps/deps-redis.yaml'`
  (safe over the existing imperative Redis — same name/labels → adopts it; Recreate strategy swaps the
  pod). Postgres/Redpanda/Vault are still imperative — same latent gap, not yet converted.

- **#stale-BullMQ `a1008402` job.** Stalled-job guard in `EngagementWorker` — detail in PENDING below
  (now marked FIXED). Files: `control-plane/src/domains/lifecycle/worker/engagement.worker.ts`
  (+`currentState` helper), `control-plane/test/engagement-worker.spec.ts` (5 tests).
  **Deploy:** rebuild + roll the fat image (recipe above) to stop the live spam.

### SSE stream stuck "Reconnecting" — FIXED (commit `7a380a0`, deployed rev 20)

**Root cause (confirmed):** `control-plane/src/domains/telemetry/sse/sse.controller.ts` does
`reply.hijack()` then `raw.writeHead(200, {...})`. `hijack()` bypasses the Fastify reply lifecycle
(onRequest/onSend), which is where the global `app.enableCors({...})` layer (`main.ts:47`) injects
`Access-Control-Allow-Origin` / `Access-Control-Allow-Credentials`. So the hijacked 200 SSE response
went to the browser with no CORS headers. A cross-origin `EventSource(url, { withCredentials: true })`
(SPA `https://autosploit.muditgarg.xyz` → API `https://api.autosploit.muditgarg.xyz`) requires
ACAO=exact-origin + ACAC=true on the actual response; without them the browser blocked it → `onerror`
→ the hook set "reconnecting" and looped. The ownership-reject path (`assertOwned` 401/404) runs BEFORE
hijack, so those errors carried CORS via the normal pipeline — only the successful 200 stream was
header-starved. This is why the browser read side never worked cross-origin; earlier token fixes were
necessary but not sufficient.

**Fix:** inject `EnvService` into `SseController` and, before `writeHead`, read `req.headers.origin`;
if it is in `env.frontendUrls` (the `FRONTEND_URL` allowlist), add to the raw header object:
`Access-Control-Allow-Origin: <matched origin>`, `Access-Control-Allow-Credentials: true`,
`Vary: Origin`. Only echo an allowlisted origin — never reflect an arbitrary one with credentials.
(`EnvService` is `@Global()` via `config.module.ts`, so no module wiring needed.)

**Verified:** `nest build` green. Deployed rev 20. Public `GET /health` → 200. Dashboard reloaded by
the owner now reaches **"live"** (was "Reconnecting"). The pre-hijack 401 path still returns CORS as
before (unchanged).

**Rule for the future:** any raw / hijacked response in this codebase must set CORS headers by hand —
the Fastify lifecycle (and therefore `enableCors`) will not run for it.

### Full attack-phase lifecycle tail — PROVEN (was the long-standing carry-forward)

Engagement `a6897391-568f-41a2-91be-96c7b7dc4cdd` on `MuditGarg007/Autosploit-test` ran end to end and
self-tore-down (first time the whole tail was watched):
- provision: `ok`, exit 0.
- attacker: exploited the target and recorded finding **F-001 — critical OS command injection** on the
  `/ping` endpoint (`GET /ping?host=127.0.0.1;id` → `uid=0(root) gid=0(root)`; source confirmed
  `subprocess.check_output("ping -c 1 " + host, shell=True)`). Root RCE.
- harness: `exit_code 0`, `halt_reason: null`, `status: complete`.
- conductor record `/tmp/autosploit-runs/<id>/conductor.json`: `status = complete`
  (started 06:32:37Z → finished 06:37:31Z, ~4m54s).
- namespace self-torn-down (gone afterward).

Note: `conductor.json report_path` is `null` and that is EXPECTED — findings flow through the telemetry
ingest → projector path (Redis last-mile + projections), which is what the dashboard detail renders.
The conductor record does not embed a report file.

---

## Build + deploy recipes

### Rebuild control-plane fat image on VPS + roll (any backend change)
```bash
ssh root@169.58.86.230
cd /root/AutoSploit-AI && git pull --ff-only     # must be on main at the target commit
TAG=$(git rev-parse --short HEAD)
docker build -f control-plane/Dockerfile -t ghcr.io/muditgarg007/control-plane:$TAG .   # ~2 min, ~2.3GB
kind load docker-image ghcr.io/muditgarg007/control-plane:$TAG --name autosploit-hardening
cd /root/AutoSploit-AI                            # helm MUST run from repo root (chart path is relative)
helm upgrade control-plane deploy/helm/control-plane -n autosploit-system \
  --reuse-values --set image.tag=$TAG --wait --timeout 6m
```
No GHCR push creds on the box — build on-box + `kind load` is the path (do not push/pull ghcr).
`--reuse-values` preserves conductor.k8s, OPENROUTER secretKeyRef, harnessImage, FRONTEND_URL,
registryMapper. Current values: `helm get values control-plane -n autosploit-system`.
**Gotcha:** the Helm deployment object is named `control-plane-control-plane-app` (not `control-plane`);
`kubectl -n autosploit-system get deploy control-plane` returns NotFound. The pod image lacks
`wget`/`curl` — probe health via the public API (`curl https://api.autosploit.muditgarg.xyz/health`).

### Frontend
Client-only changes ride Vercel auto-deploy of `main` (just push). Live site
`https://autosploit.muditgarg.xyz`, API `https://api.autosploit.muditgarg.xyz`
(NodePort 30080 → plane:3000 via Caddy).

### Verify an engagement live
```bash
NS=engagement-<id>
kubectl -n $NS get pods -w        # registry→build(Completed)→target(Running)+attacker(Running)
kubectl -n $NS logs attacker -f   # phase / tool_call / tool_result / cost / finding events
# completion: ns self-tears-down; conductor.json at /tmp/autosploit-runs/<id>/ in the plane pod,
#   CONDUCTOR_OUT_DIR=/tmp/autosploit-runs. status=complete when done.
```

---

## PENDING / carry-forward (still open)

- **Stale `a1008402` BullMQ job — FIXED (code) 2026-10-10, NOT YET DEPLOYED.** Root cause: the
  re-delivery was BullMQ *stalled-job* re-processing (worker pod restart mid-run → lock lost → job
  back to `wait` → re-run); `attempts: 1` does not cover a stall. On re-run the worker re-walked
  `provisioning→deploying→attacking` on a row already at `attacking`/terminal → every flip illegal →
  `Illegal state transition` warn spam, and would re-spawn the conductor for a torn-down engagement.
  `waitForState('dispatched')` did NOT guard this (it returns early for any non-`queued` state). Fix:
  a **startable-state guard** in `EngagementWorker.runConductor` — right after `waitForState`, read
  the row; any state other than `dispatched` (or a vanished row) means this is not the first delivery,
  so ack the job (return, no throw) and leave the row untouched (`engagement.worker.ts`, new
  `currentState` helper). Unit spec `control-plane/test/engagement-worker.spec.ts` (5 tests, hermetic:
  skips redelivery at attacking/completed/failed/halted; first delivery at `dispatched` still walks).
  `nest build` green. **Deploy:** rebuild + roll the fat image (recipe above) to stop the live spam.
- **Harness image is local `h3-local` tag, not digest-pinned.** `conductor.harnessImage=
  docker.io/library/harness:h3-local`, present on the node via kind load. M5 release pipeline owes a
  digest-pinned push. Fine on single-node kind; breaks multi-node / GKE.
- **#1 Redis not in any manifest.** Created imperatively; a node/pod wipe drops it and engagements hang
  at "starting" (tell: quota-meter log). Restore `kubectl create deployment redis --image=redis:7-alpine
  -n autosploit-system` (+ service). Check Redis first if engagements hang.
- **#5 Discovery mis-rejects an immediately-exiting container.** `provisioner/.../discovery/ports.py
  ::discover` races: a container that exits immediately with no ports can be caught `running` with an
  empty port map → raises `NoPortsExposed`, should be `BootTimeout`. Repro
  `provisioner/tests/test_discovery.py::test_container_exits_immediately_rejects_boottimeout` (integration,
  needs Docker). Off the dashboard path. Detail in project `CLAUDE.md`.

---

## Key files
- SSE server: `control-plane/src/domains/telemetry/sse/sse.controller.ts` (hijack + writeHead; the CORS
  echo is the fix — `req.headers.origin` checked against `env.frontendUrls`).
- CORS: `control-plane/src/main.ts:47` (`enableCors`); allowlist `control-plane/src/config/env.service.ts:56`
  (`frontendUrls`, from `FRONTEND_URL`); `EnvService` is `@Global()` (`config.module.ts`).
- Session guard: `control-plane/src/core/guards/session.guard.ts` (stateless HS256; accepts
  `access_token` query param on the `/stream` route only).
- Client stream hook: `client/hooks/useEngagementStream.ts`; client token single-flight: `client/lib/token.ts`.
