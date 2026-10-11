# Handoff — dashboard live data: event pipeline fixed end-to-end to the DB; dashboard still shows nothing

Date: 2026-10-10. Branch `main`. Control-plane **helm rev 25**, image
`ghcr.io/muditgarg007/control-plane:a7a42d2` (fat image, conductor in-process).

## TL;DR

The reported bug ("dashboard not displaying live data") was **two stacked
backend breaks in the telemetry producer path**, both now fixed, committed,
pushed, and deployed. The pipeline is proven live as far as the Postgres
projection tables (cost rows land, Kafka offsets climb, zero relay failures).

**But the dashboard still shows nothing.** So there is at least one more gap,
now located downstream of the DB projection — either the dashboard read path
(engagements list rollup / per-user scoping / SSE), or the fact that `findings`
is still 0 while only `cost` rows exist. This is where the next session picks up.

## What was wrong and what was fixed

### Bug 1 — k8s mode never piped the attacker Pod's event stream anywhere (commit `e86ff38`)

The harness writes its JSONL event feed (`phase`/`tool_call`/`tool_result`/
`finding`/`cost`/…) to the attacker container's stdout. The live path depends on
the control-plane worker reading the **conductor subprocess** stdout line by line
and relaying each event to `POST /engagements/:id/events` (`engagement.worker.ts`
→ `IngestRelay`). In Phase A `launch.py` streams the harness subprocess stdout up,
so that works. But in **k8s mode (`--k8s`)** `conductor/.../k8s/run.py::run_k8s`
created the attacker as a Pod and `k8s/watch.py` only polled `status.phase`;
`_collect_logs` read the Pod log once at the end into a **file**, never to stdout.
So no harness event ever reached the worker relay → Kafka topic
`autosploit.events` stayed at offset 0 → dashboard empty, every run.

Fix: `run_k8s` now `wait_pod_running` then follows the attacker Pod log on a
daemon thread (`EngagementCluster.stream_pod_logs`, `read_namespaced_pod_log
follow=True, _preload_content=False`), re-emitting each line to the conductor's
own stdout, key-scrubbed — Phase-A parity. The existing worker readline→relay
path carries the events unchanged. Lifecycle is still decided by the phase poll;
`_collect_logs` still writes the file artifact. Conductor suite 176 passed, 2
skipped (the known `test_k8s_cache.py` self-import collection quirk, unrelated).

### Bug 2 — the relay POSTed to an unreachable host (commit `a7a42d2`)

With Bug 1 fixed, a fresh engagement confirmed the harness emits fine and **every
event reached the worker's `IngestRelay`** — but each POST failed with
`ingest relay <id> failed: fetch failed`. The relay targeted `env.publicBaseUrl`,
which the deploy sets to `PUBLIC_BASE_URL=http://control-plane`. The worker runs
**inside the plane pod**, and `http://control-plane` does not resolve from inside
the pod — the Service is actually named `control-plane-control-plane`. So every
relay `fetch` failed, nothing was produced to Kafka, dashboard stayed empty.

Fix: new `EnvService.ingestRelayBaseUrl`, defaulting to `http://localhost:${port}`
(override `INGEST_RELAY_BASE_URL`); `IngestRelay` now POSTs loopback, independent
of the external `PUBLIC_BASE_URL`. The worker is always in the same pod as the
HTTP listener, so loopback is always correct. `publicBaseUrl` keeps its external
meaning (links/proxy) and currently has no other consumer. `nest build` green;
`hardening.spec` (relay/ingest parity, 5 tests) passed.

## Proof captured on rev 25 (engagement `710928d9-c09d-4757-9284-b97ca5185f06`)

A fresh engagement after both fixes, attacker Running:

- Kafka topic `autosploit.events` high-watermark climbed **0 → 6 → 12** (was
  pinned at 0 for every prior run).
- Relay failures in the plane log: **0** (`grep -c "ingest relay.*failed"`).
- Postgres `control_plane`: `cost` = **4 rows**, `findings` = **0**.

So: harness → stdout → conductor follow-thread → worker relay → ingest → Kafka →
projector → **Postgres** is working. The backend telemetry path is no longer the
blocker.

## Still open — dashboard shows nothing despite cost rows in the DB

`cost` rows are being projected but the dashboard renders nothing. Narrow it from
the read side. Likely suspects, in order:

1. **Engagements-list rollup / per-user scoping.** The overview tiles read a
   join over the `engagements` list plus findings/spend rollup (commit `0bbf0e5`,
   correlated subqueries + frontend `toRow`). Check that engagement
   `710928d9-…` has a row in `engagements`, that it is associated with the
   logged-in user (owner/org scoping in `GET /engagements`), and that the spend
   rollup subquery actually keys on the same id the `cost` rows carry. If the
   list excludes the run or the join key mismatches, tiles stay 0 even with rows
   present. Pull the raw `GET /engagements` response the dashboard receives and
   compare to the DB.
2. **`findings` = 0 vs `cost` = 4.** Confirm whether the attacker actually
   emitted any `finding` events this run (`kubectl -n engagement-710928d9-… logs
   attacker | grep '"type": "finding"'`). On the testbed it exercises SSTI
   (`{{7*7}}`→49), command injection (`;id`→`uid=0(root)`), SQLi and path
   traversal, so `note_finding` should fire — if the harness emits findings but
   the DB `findings` table stays 0, the projector is dropping the `finding` event
   type specifically (check the projector's type handling / the `note_finding`
   event schema vs the projector's expected shape). If the harness emits none,
   that is a harness/agent issue, not a pipeline one.
3. **SSE live feed.** The dashboard's live tail is the `autosploit-sse-bridge`
   consumer → SSE hijack endpoint (the CORS/hijack fix shipped rev 20). The
   rollup is DB-backed and should show on reload regardless of SSE, so start with
   (1)/(2); only chase SSE if the DB clearly has the rows the tile should show and
   a plain reload still shows nothing.

### Fast triage commands

```bash
VPS=root@169.58.86.230
# DB: does the run exist in engagements, and what does its rollup look like?
ssh $VPS 'kubectl -n autosploit-system exec deploy/postgres -- psql -U postgres -d control_plane -c \
  "select id, status, user_id, created_at from engagements order by created_at desc limit 5;"'
ssh $VPS 'kubectl -n autosploit-system exec deploy/postgres -- psql -U postgres -d control_plane -c \
  "select engagement_id, count(*) from cost group by 1; select engagement_id, count(*) from findings group by 1;"'
# Did the harness emit any finding events this run?
ssh $VPS 'kubectl -n engagement-710928d9-c09d-4757-9284-b97ca5185f06 logs attacker | grep -c "\"type\": \"finding\""'
# Plane: projector errors / dropped event types
ssh $VPS 'P=$(kubectl -n autosploit-system get pod -l app=control-plane --field-selector=status.phase=Running -o jsonpath="{.items[0].metadata.name}"); \
  kubectl -n autosploit-system logs $P | grep -iE "projector|finding|unknown event|drop" | tail -30'
# What the dashboard actually receives (run with a valid bearer token):
#   GET https://<public>/engagements   -> compare ids + spend to the DB
```

## Deploy notes (so the next session can rebuild without rediscovery)

- Build is **on-box on the VPS** (no GHCR push creds); the fat image bundles the
  conductor venv + node binary + helm/crane, ~2.3 GB, cold build ~15 min:
  ```bash
  ssh root@169.58.86.230
  cd /root/AutoSploit-AI && git fetch origin && git reset --hard origin/main
  TAG=$(git rev-parse --short HEAD)
  docker build -f control-plane/Dockerfile -t ghcr.io/muditgarg007/control-plane:$TAG .
  kind load docker-image ghcr.io/muditgarg007/control-plane:$TAG --name autosploit-hardening
  helm upgrade control-plane deploy/helm/control-plane -n autosploit-system \
    --reuse-values --set image.tag=$TAG --wait --timeout 6m
  ```
- **Disk watch:** the VPS root filled to 99% during this session; `docker builder
  prune -af` reclaimed ~22 GB. Check `df -h /` before a build; if tight, prune the
  build cache first.
- Each control-plane redeploy restarts the plane pod and **kills the conductor
  subprocess of any in-flight engagement** (its attacker Pod is orphaned and keeps
  burning budget until timeout). Delete stale `engagement-*` namespaces after a
  redeploy.
- A node wipe/recreate drops node-loaded images (control-plane and the
  digest-pinned harness) — re-run the `kind load` / `docker save | kind load
  image-archive` steps. See the harness-digest and node-pull notes.

## Files touched this session

- `conductor/src/autosploit_conductor/k8s/run.py` — `_relay_logs` daemon thread +
  `wait_pod_running` gate in `_run_engagement`.
- `conductor/src/autosploit_conductor/k8s/client.py` — `EngagementCluster.stream_pod_logs`;
  Protocol `read_namespaced_pod_log(..., **kwargs)`.
- `conductor/tests/test_k8s_run.py`, `conductor/tests/test_k8s_client.py` — live-stream
  relay + redaction tests; streaming/str log-path tests.
- `control-plane/src/config/env.service.ts` — `ingestRelayBaseUrl`.
- `control-plane/src/domains/lifecycle/worker/ingest-relay.ts` — POST to loopback.

Commits: `e86ff38`, `a7a42d2` (both on `main`, pushed).
