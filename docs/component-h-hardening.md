# Component H — Hardening / release (cross-cutting, closes the build)

> **Status: planning / pre-build (2026-09-07).** Implementation record for the
> hardening + release layer named in `docs/control-plane.md §12` (Component H) and
> the security model of `docs/overview.md §4, §4.1`. Components 0, A–E, and Q are
> built; H is the **last** component — the second of the two cross-cutting layers
> that ride on top of C and D (`control-plane.md §12`: *"Dependency spine: P0 → A →
> B → C → D → E, with Quota and Hardening riding on top once C and D exist."*). H
> writes almost no new business logic: it **proves the two security seams the whole
> design rests on hold under adversarial conditions**, adds the observability spine,
> and ships the deploy path onto GKE.

---

## 1. One-line job

Take the two load-bearing security invariants that have been *designed in* since
`overview.md §4` — **the sandbox pushes up on exactly one edge, and the two secrets
never cross into the wrong plane** — and turn them from "true by construction" into
"proven true under a red-team pass," then make a full engagement
`dispatch → provision → attack → ingest` **traceable end to end by `engagement_id`**
on a real GKE deploy. H closes the build: after it, the invariants are enforced *and
verified*, and the system is deployable, not just runnable.

---

## 2. Scope of THIS component

**In scope**

- **Egress-matrix enforcement + proof.** The `overview.md §4.1` matrix (two edges
  leave the sandbox; the plane never reaches *down*) is enforced by NetworkPolicy
  (`orchestration.md §4`) and by the control plane's own shape, and a red-team pass
  confirms there is **no inbound path from sandbox to plane other than ingest**.
- **Secret-split proof.** The GitHub token flows vault → dispatch → provisioner
  clone-only, never logged, never to the harness; `OPENROUTER_API_KEY` never enters
  the plane. H adds the tests + a leak scanner that make this **checkable**, not
  asserted.
- **Phase-B parity.** The attacker Pod POSTs the **same** ingest endpoint the
  Phase-A worker relays to — one endpoint, unchanged across phases — verified by a
  parity test that runs both producers against one ingest.
- **Observability spine.** OpenTelemetry traces + Prometheus metrics + Pino
  structured logs, **all correlated by `engagement_id`**, so one engagement is a
  single trace from the dispatch HTTP span through the conductor subprocess to the
  ingest span.
- **Release path.** Dockerfile for the control plane, a Helm chart for the plane's
  own workloads, Terraform for the GKE cluster + registry + Vault + IAM, and a GH
  Actions pipeline that builds/scans/pushes to GHCR and deploys.

**Out of scope (owned elsewhere)**

- **The isolation runtime, NetworkPolicy authoring, gVisor, the per-engagement
  namespace** → **orchestration** (`orchestration.md §3, §4`). H *verifies* the
  egress matrix these produce; it does not author the CNI policy. The engagement
  namespace's Helm chart is the orchestration layer's; H ships the **control
  plane's own** chart (the long-lived Deployment + its consumers), which is a
  different workload.
- **The secrets themselves.** The token vault (Vault Transit) is slice A
  (`control-plane.md §4.A`); the model key lives conductor-side (`orchestration.md
  §2`). H proves they stay on their side of the boundary; it does not own either.
- **The ingest endpoint / SSE / consumer groups** → **D · Telemetry**. H does not
  add a telemetry route; it drives the *existing* ingest from a second producer
  (Phase B) and asserts parity.
- **Business features.** No new client-facing capability, no new domain table. H is
  cross-cutting hardening + ops, exactly like Q is cross-cutting enforcement.

H, like Q, is **not a slice** (`control-plane.md §5`): it owns no authoritative
table and adds no client route. It adds one cross-cutting concern (observability
middleware) and a body of **tests + infra**, and it is where the security story the
docs have promised since day one is finally *demonstrated*.

---

## 3. Load-bearing decisions

These fix the shape of everything below.

### 3.1 H **proves** invariants; it does not **introduce** them

The egress matrix and the secret split are not new work — they have been enforced by
construction since the earliest slices:

- The control plane has **exactly one inbound edge from an engagement**: the
  authenticated `POST /engagements/:id/events` ingest endpoint, guarded by
  `IngestTokenGuard` (`telemetry/ingest/ingest-token.guard.ts`). There is **no code
  path anywhere in the plane that reaches *into* a running engagement** — the worker
  only `spawn`s a subprocess and reads its stdout (`worker/engagement.worker.ts`);
  in Phase B it does not even do that, the Pod POSTs on its own. This is
  `control-plane.md §3 rule 4`, already true.
- The GitHub token is redacted from conductor stderr before it can reach a log
  (`worker/engagement.worker.ts:141` — `replaceAll(githubToken, '<redacted>')`),
  passed to the conductor **only** as the `GITHUB_TOKEN` env var for the cloner
  (`:115`), and `OPENROUTER_API_KEY` is *deliberately absent* from `EnvService`
  (`config/env.service.ts:4` — "the control plane never holds the model key").

> H's job is therefore **verification engineering**, not feature engineering: write
> the adversarial tests and the leak scanner that would *fail* if any of these ever
> regressed, and wire the trace that makes a violation visible in production. The one
> genuinely new subsystem is observability (§6) — everything else is a test, a
> scanner, or a deploy artifact.

### 3.2 The egress matrix is enforced in **two independent layers**, and H checks both

The `overview.md §4.1` matrix is defended twice, so a hole in one layer is not a
breach:

1. **Network layer (orchestration):** the per-engagement `NetworkPolicy`
   default-denies egress and allows exactly `attacker → target`, `attacker → model
   API`, `attacker → control plane (events)` (`orchestration.md §4`). This is where
   an *in-container escape* is contained.
2. **Application layer (control plane):** even if a packet reaches the plane, the
   only route that accepts an engagement's traffic is ingest, and it is
   **fail-closed** — `IngestTokenGuard` rejects a missing/invalid/mis-scoped token
   with 401/403 before any handler runs. There is no un-authenticated inbound
   surface an engagement could hit.

H's red-team pass (§7) probes **both**: from inside a sandbox it confirms every
non-allowed egress is dropped (network layer), and against the plane it confirms
every route except ingest is either unreachable from the sandbox network or
rejects an engagement-shaped request (application layer). "No inbound path other
than ingest" is the conjunction of the two.

### 3.3 Correlation is by `engagement_id`, the one identifier every plane already shares

`engagement_id` is the partition key on the Kafka topic, the `sub` of the ingest
token, the subject of the SSE subscription, the conductor's `--engagement-id` arg,
and the primary key of the `engagements` table. It is the **natural trace
correlation id** — nothing new needs minting. H's observability spine (§6) stamps
every span, metric label, and log line with it, so "show me everything that
happened for engagement X" is one query across traces, metrics, and logs, and the
`dispatch → provision → attack → ingest` trace the exit gate demands is
`engagement_id`-keyed for free.

The one seam to bridge is the **Python ↔ TS trace boundary**: the conductor +
harness are Python subprocesses (Phase A) or Pods (Phase B), and the plane is TS.
H propagates trace context across that border through the same event stream that
already crosses it (§6.3) rather than inventing a second channel — the same
philosophy as `control-plane.md §8.1` ("the border is frozen as data, not code").

### 3.4 Observability is a **global cross-cutting concern**, wired like Quota

Following the pattern Q established (`component-q-quota.md §3.3`): observability is
not a slice, it is cross-cutting middleware. It ships as a small `core/observability/`
module — a global Nest interceptor that opens the per-request span and binds the
`engagement_id` to the async context, plus the OTel SDK bootstrap in `main.ts` and a
Pino logger config. No domain module imports it; it observes them from the outside,
exactly as `QuotaInterceptor` enforces from the outside.

### 3.5 Deploy ships the **plane**, not the engagement — two different charts

`orchestration.md §8` already owns the *engagement* Helm chart (namespace, attacker
Pod, target Pod, Service, NetworkPolicy — the ephemeral per-run resources). H ships
the **control plane's own** chart: the long-lived Deployment (NestJS app + BullMQ
worker), the Redpanda + Redis + Postgres it depends on (or their managed
equivalents), Vault, and the Kafka Connect S3 sink. These are two disjoint workloads
with disjoint lifecycles (one long-lived and singular, one ephemeral and per-run), so
they are two charts, not one — conflating them would couple the plane's release
cadence to an engagement's teardown.

### 3.6 Fail-closed everywhere the boundary is load-bearing; H never weakens a gate

Unlike Q, which deliberately **fails open** on an unreachable meter
(`component-q-quota.md §3.5`, because the harness budget is the hard backstop), every
seam H hardens is **fail-closed** and stays so:

- Ingest with a missing/invalid token → 401/403 (`IngestTokenGuard`, already
  fail-closed).
- Missing signing key at mint → throw, never a garbage token
  (`ingest-token.service.ts:27`).
- NetworkPolicy default-deny → an un-matched egress is dropped, not logged-and-allowed.

H's tests assert the *fail-closed* branch of each. The observability spine is the one
piece that is fail-*open* by necessity (a tracing exporter being down must never take
the plane down), and it is isolated so its failure degrades visibility only, never a
security control.

---

## 4. Where H sits in the flow — the two seams under test

```
                    ┌─────────────────────── CONTROL PLANE (trusted) ───────────────────────┐
                    │                                                                        │
  CLIENT ──POST /engagements──► C.dispatch ── mint ingest token ── decrypt GH token ─┐       │
                    │                                        │                        │       │
                    │                       ┌────────────────┘  Vault (A)             ▼       │
                    │                       ▼                                    BullMQ queue  │
                    │                 quota gate (Q)                                   │       │
                    │                                                          worker (Phase A)│
                    │  ▲                                                               │       │
                    │  │ ONE inbound edge:                                    spawn conductor  │
                    │  │ POST /:id/events                                     env: GITHUB_TOKEN │  ◄── SEAM 2: secret split
                    │  │ (IngestTokenGuard, fail-closed)                      (no OPENROUTER)   │      GH token → clone only,
                    └──┼───────────────────────────────────────────────────────────┼─────────┘      redacted from logs;
                       │                                                            │                 model key never here
     ══════════════════╪════════════════════════════════════════════════════════════╪══════════════
       SANDBOX (untrusted)  ◄── SEAM 1: egress matrix ──►                            │
                       │   NetworkPolicy default-deny:                       Phase A: conductor stdout
   Phase A: worker relays conductor stdout ──────────────► POST /:id/events           │  relayed up
   Phase B: attacker Pod POSTs directly ─────────────────► POST /:id/events  ◄────────┘  Phase B: Pod POSTs
                       │   ALLOW attacker→target, attacker→model, sandbox→plane(events)
                       │   DENY  everything else  ← red-team probes this
```

Two seams, tested independently and together:

- **SEAM 1 — egress matrix (`overview.md §4.1`).** Enforced by NetworkPolicy
  (network layer) and by the plane having one fail-closed inbound route
  (application layer). Red-team confirms only ingest is inbound.
- **SEAM 2 — secret split (`overview.md §4`, `orchestration.md §2`).** GitHub token:
  Vault → dispatch decrypt → conductor `GITHUB_TOKEN` env → provisioner clone only,
  redacted from stderr, never to the harness. Model key: conductor-only, never in
  `EnvService`, never in a plane log. H proves both directions.

**Phase-B parity** rides on SEAM 1: the ingest endpoint is *the same* whether the
Phase-A worker relays stdout or the Phase-B Pod POSTs — the relay comment already
freezes this (`worker/ingest-relay.ts:5-7`), and H's parity test drives both
producers at one ingest and asserts identical acceptance.

---

## 5. The proofs — what "hardened" means, checkably

Each proof is an adversarial test (or scanner) that would **fail if the invariant
regressed**. This is the substance of H.

### 5.1 Egress: only ingest is inbound

- **Network-layer probe (red-team, §7).** From a Pod on the engagement namespace's
  network, attempt egress to: (a) the target Service → **allowed**; (b) the model
  API host → **allowed**; (c) the control-plane ingest → **allowed**; (d) the
  control-plane's *other* ports (Postgres 5432, Redis 6379, Redpanda 9092, the app's
  non-ingest routes, arbitrary internet) → **all denied/dropped**. Assert (d) is
  empty.
- **Application-layer probe.** Against the plane's public surface, send an
  engagement-shaped request to every route *except* ingest with an ingest token (not
  a session) → every one is 401/403/404, because session routes require a session
  cookie/JWT the sandbox never has, and ingest is the only route that accepts an
  ingest token. Assert the plane exposes **no route that an engagement's credential
  can drive except ingest**.
- **"Never reaches down" static check.** A test/grep that asserts the plane contains
  **no** outbound call *into* a sandbox: no `kubectl exec`, no Pod-exec client call,
  no connection *initiated* by the plane toward an engagement Pod. The plane's only
  engagement-directed I/O is reading its own spawned subprocess's stdout (Phase A),
  which is not a network reach-down. Codified as a lint/architecture test so a future
  reach-down fails CI.

### 5.2 Secret split: GitHub token never leaks, model key never enters

- **GH token never in logs.** Drive an engagement whose conductor writes the token
  to stderr; assert the relayed logs, the Pino output, and the persisted event
  stream contain `<redacted>` and **never** the token bytes
  (`worker/engagement.worker.ts:141` is the enforcement; this is its test).
- **GH token never to the harness.** Assert the harness subprocess env (Phase A) /
  Pod env (Phase B) does **not** carry `GITHUB_TOKEN` — only the provisioner/cloner
  step sees it. (The conductor passes it to the cloner, never forwards it to the
  attacker; `orchestration.md §2, §5`.)
- **Model key never in the plane.** A **leak scanner** in CI greps the built plane
  image + its config + its logs for `OPENROUTER_API_KEY` and for the key's shape;
  assert zero hits. `EnvService` has no field for it (`config/env.service.ts:4-5`),
  so this is a regression guard, not a fix.
- **GH token at rest is ciphertext.** Re-assert slice A's property (Vault Transit;
  `component-A` exit gate) from H's vantage: plaintext never lands in Postgres or
  logs. H folds this into the leak scanner so the whole secret story is one gate.

### 5.3 Phase-B parity: one ingest endpoint, two producers

- **Parity test.** Stand up ingest; produce the identical event via (a) the Phase-A
  `IngestRelay` and (b) a direct POST simulating the Phase-B attacker Pod. Assert:
  same auth (both carry the per-engagement ingest token), same schema validation,
  same acceptance, same landing on the Kafka topic. The endpoint URL, guard, and
  body contract are byte-identical across the two — proving the "endpoint never
  changes between phases" claim (`control-plane.md §6`, `worker/ingest-relay.ts:5`).

### 5.4 Trace correlation: one engagement, one trace

- **End-to-end trace test.** Run a full engagement with the observability SDK
  active; assert a single trace, keyed by `engagement_id`, contains spans for
  `POST /engagements` (dispatch) → the worker's conductor spawn (provision/deploy/
  attack phases) → the `POST /:id/events` ingest spans, with the `engagement_id`
  present as a span attribute and a log-correlation field on every related Pino line.
  This is the exit gate's "full dispatch→provision→attack→ingest trace correlated by
  `engagement_id`," checked in a test before it is demoed on GKE.

---

## 6. The observability spine (the one new subsystem)

The only substantial new *code* in H. Ships in `core/observability/`, wired global
like Quota's interceptor.

### 6.1 What each tool answers (the §9.1 lens — every pick maps to a requirement)

| Tool | Requirement it answers |
|------|------------------------|
| **OpenTelemetry** (`@opentelemetry/sdk-node`, auto-instrumentations) | one distributed trace across HTTP → BullMQ → subprocess → ingest, correlated by `engagement_id` (`control-plane.md §9.1`) |
| **Prometheus** (`prom-client`, `/metrics`) | RED metrics per route + per consumer group + queue depth + dispatch rejections (Q's 429s), labeled by outcome |
| **Grafana** | dashboards over the Prometheus + trace data; the ops view `control-plane.md §11` flags as missing |
| **Pino** (`nestjs-pino`) | structured JSON logs with an `engagement_id` field, already the plane's logger of record (`control-plane.md §9.1`) |

### 6.2 Wiring

- **SDK bootstrap in `main.ts`.** Start the OTel Node SDK **before** `NestFactory`
  so auto-instrumentation patches Fastify, `pg`, `ioredis`, and `kafkajs`. OTLP
  exporter to the collector; resource attributes name the service. Guarded by
  `OTEL_ENABLED` so local/CI runs need no collector (fail-open, §3.6).
- **Global `ObservabilityInterceptor` (`APP_INTERCEPTOR`).** On each request,
  extract `engagement_id` from the route param / body, set it as the active span
  attribute, and bind it into the async-local context so every downstream log line
  and child span carries it. Same global-interceptor shape as `QuotaInterceptor`
  (`component-q-quota.md §3.3`), and it runs after guards so `request.user` +
  `:id` are populated.
- **Worker span.** The BullMQ worker opens a span per job, linked to the dispatch
  span via trace context carried in the job payload (add `traceparent` to
  `EngagementJobData` — additive), so the async hop from HTTP dispatch to worker
  execution stays in one trace.
- **`/metrics` route** (Prometheus scrape) and a `PinoLogger` swapped in as the Nest
  logger, `engagement_id` in every log context.

### 6.3 The Python ↔ TS trace boundary

The conductor/harness are Python (subprocess in Phase A, Pod in Phase B). To keep
one trace across the language border, propagate W3C trace context **through the event
stream that already crosses it** (§3.3): the worker passes the current `traceparent`
to the conductor (Phase A: an env var / CLI flag; Phase B: a Pod env var from the
launcher), the harness stamps it onto emitted events, and the ingest span extracts it
as the parent. No second channel — the border stays "data, not code"
(`control-plane.md §8.1`). *Harness-side emission of `traceparent` is a small,
additive contract touch; flagged in §12 Q2 as the one cross-repo dependency.*

---

## 7. The red-team pass

The exit gate's central artifact. A scripted adversarial run (checked into
`control-plane/test/redteam/` or a `scripts/redteam.sh`) that a human can re-run, and
that CI can run in a reduced form against the local cluster.

1. **Stand up an engagement** on the local k3s/kind cluster (`orchestration.md §9`
   Phase B substrate) with the real NetworkPolicy applied.
2. **Egress sweep** from a Pod on the engagement network (§5.1): enumerate every
   destination in the `overview.md §4.1` matrix + a denylist of everything else;
   assert allow/deny matches the matrix exactly, `DENY` set is empty of successes.
3. **Inbound sweep** against the plane (§5.1 application layer): every route but
   ingest rejects an engagement credential.
4. **Secret sweep** (§5.2): induce a token-in-stderr, scan all sinks for the token
   and for `OPENROUTER_API_KEY`; assert zero leaks.
5. **Parity check** (§5.3): both producers, one ingest.
6. **Trace check** (§5.4): pull the trace by `engagement_id`, assert the full
   dispatch→provision→attack→ingest chain is present and correlated.

The pass **fails loudly** on any deviation; a green run is the exit-gate evidence.

---

## 8. Release path

### 8.1 Container image

- **`control-plane/Dockerfile`** — multi-stage: Bun install + `bun run build`
  (turbo: contracts then nest build) → a slim **Node 22** runtime image (runtime
  stays Node, `control-plane.md §9.1`), non-root user, the built `dist/` + prod
  deps only. One image runs both the HTTP app and the BullMQ worker (same monolith,
  selected by a start flag / env).
- **Image scan** in CI (Trivy or `docker scout`) before push; fail on high/critical.

### 8.2 Helm chart (the plane's own workload — §3.5)

`deploy/helm/control-plane/`:
- Deployment (app + worker), Service, HPA (optional), `/health` liveness +
  readiness probes (the `core/health` controller already exists), `/metrics`
  annotated for Prometheus scrape.
- Dependencies as subcharts or external refs: Postgres, Redis, Redpanda + Schema
  Registry, Kafka Connect (S3 sink), Vault. Managed equivalents on GKE where they
  exist; the chart parameterizes endpoints via values.
- Secrets from k8s Secrets / Vault; **no secret baked into the image** (leak
  scanner §5.2 guards this).
- ServiceAccount wired to Vault's k8s auth method (`control-plane.md §9.1` — no
  static bootstrap secret; `EnvService` already keys off `KUBERNETES_SERVICE_HOST`,
  `config/env.service.ts:44-50`).

### 8.3 Terraform

`deploy/terraform/`: GKE Autopilot cluster (`orchestration.md §7` demo substrate),
GHCR pull config, Vault + Transit engine + policy + k8s auth role
(`control-plane.md §9.1`), object-store bucket (S3/MinIO for Reports + the Connect
sink), IAM/service accounts. Cluster spun up only when demoing to keep cost near zero
(`orchestration.md §7`).

### 8.4 CI/CD (extends `.github/workflows/ci.yml`)

The existing `ci.yml` runs build + test + lint + typecheck on real Postgres via
Testcontainers. H adds a **release workflow**:
- On tag / main: build the image, scan (§8.1), push to **GHCR**.
- Run the reduced red-team pass (§7) against an ephemeral kind cluster in CI.
- Deploy to GKE via Helm (manual approval gate for prod).

---

## 9. Config — `EnvService` additions

Follows existing conventions (typed, read once, sensible default; observability
disabled by default so local/CI needs no collector — §3.6).

```ts
// --- Observability (Component H) — OTel + Prometheus + Pino ---
// Master switch: when false, the OTel SDK is not started (local/CI need no
// collector). Metrics endpoint + Pino stay on; only trace export is gated.
readonly otelEnabled = (process.env.OTEL_ENABLED ?? 'false') === 'true';
readonly otelExporterEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
readonly otelServiceName = process.env.OTEL_SERVICE_NAME ?? 'autosploit-control-plane';
// Log level for Pino; JSON in prod, pretty in dev.
readonly logLevel = process.env.LOG_LEVEL ?? (this.isProd ? 'info' : 'debug');
```

No new *required* var — H must not make the plane refuse to boot without a
collector. Add the four to `.env.example` with the "trace export off by default"
note.

---

## 10. File-by-file change list

**New — observability (`control-plane/src/core/observability/`):**

- `otel.ts` — the OTel Node SDK bootstrap (exporter, resource, auto-instrumentations),
  imported first in `main.ts`, guarded by `otelEnabled`.
- `observability.interceptor.ts` — global `APP_INTERCEPTOR`; binds `engagement_id`
  to the active span + async context (§6.2).
- `observability.module.ts` — `@Global()`; provides the interceptor + `prom-client`
  registry; exposes the metrics provider.
- `metrics.controller.ts` — `GET /metrics` (Prometheus scrape).

**New — release + red-team:**

- `control-plane/Dockerfile` — multi-stage build → Node 22 runtime (§8.1).
- `deploy/helm/control-plane/` — the plane's chart (§8.2).
- `deploy/terraform/` — GKE + Vault + registry + IAM (§8.3).
- `control-plane/test/redteam/` (or `scripts/redteam.sh`) — the red-team pass (§7).
- `control-plane/test/hardening.spec.ts` — the proofs runnable in CI (§5, §11).
- `.github/workflows/release.yml` — build/scan/push/deploy + reduced red-team (§8.4).

**Edited (small, additive):**

- `main.ts` — import + start the OTel SDK before `NestFactory`; swap in `PinoLogger`.
- `config/env.service.ts` — the four `otel*`/`logLevel` fields (§9).
- `.env.example` — document them.
- `app.module.ts` — register `ObservabilityModule`; register the global
  `ObservabilityInterceptor`.
- `domains/lifecycle/queue/engagement-queue.ts` — add `traceparent?: string` to
  `EngagementJobData` (trace propagation across the BullMQ hop, §6.2). Additive
  field.
- `domains/lifecycle/worker/engagement.worker.ts` — open a worker span linked via
  the job's `traceparent`; pass `traceparent` to the conductor (§6.3). No change to
  the state-machine logic or the secret handling — those are what H *tests*, not
  edits.

**Untouched (proof of the boundary):** every `domains/*` service/schema write path,
the ingest guard, the state machine. H **adds tests around** the existing security
seams and **observes** the existing flow; it changes no authoritative logic. The
one behavioral edit (trace propagation on the job payload) is additive and cannot
alter a state transition or a secret's path.

---

## 11. Testing plan (maps 1:1 to the exit gate)

New spec `control-plane/test/hardening.spec.ts` + the red-team script (§7),
Testcontainers Postgres + Redis + Redpanda (mirrors `telemetry-durable.spec.ts`).
The red-team network probes need a cluster, so they run in the CI kind job (§8.4)
and as the human-run pass; the rest run in the normal spec.

1. **Only ingest is inbound (application layer).** Send an engagement-shaped request
   with an ingest token to every non-ingest route → all 401/403/404; ingest with the
   *correct* token → 202. Proves the application-layer half of SEAM 1 (§5.1).
2. **No reach-down (static/architecture test).** Assert the plane source has no
   Pod-exec / sandbox-directed outbound call (§5.1). Fails CI if a reach-down is
   ever added.
3. **GH token never leaks.** Engagement whose conductor emits the token on stderr →
   assert `<redacted>` in logs and the token bytes absent from logs + persisted
   events (§5.2).
4. **GH token never to the harness.** Assert the harness process/Pod env lacks
   `GITHUB_TOKEN` (§5.2).
5. **Model key never in the plane.** Leak scanner over the image + config + logs →
   zero `OPENROUTER_API_KEY` hits (§5.2).
6. **Phase-B parity.** Same event via the Phase-A relay and a direct Phase-B POST →
   identical auth, validation, acceptance, topic landing (§5.3).
7. **End-to-end trace.** Full engagement with OTel active → one trace keyed by
   `engagement_id` spanning dispatch → conductor phases → ingest (§5.4).
8. **Red-team egress sweep (CI kind job + human pass).** The `overview.md §4.1`
   matrix enforced exactly; the DENY set has zero successful egresses (§7 step 2).

Unit tests: the `ObservabilityInterceptor`'s `engagement_id` extraction across
route param / body shapes; the trace-context propagation round-trip through
`EngagementJobData`.

---

## 12. Build order (sub-milestones, each demoable)

1. **H0 — observability spine.** `core/observability/`, OTel bootstrap, Pino swap,
   `/metrics`, the `engagement_id` interceptor + worker span + BullMQ trace
   propagation. Demo: one engagement is one trace in the collector, keyed by
   `engagement_id`. *(Satisfies the trace half of the gate.)*
2. **H1 — the proofs as tests.** `hardening.spec.ts`: inbound-only, no-reach-down,
   secret-split (both directions), leak scanner, Phase-B parity, end-to-end trace.
   Demo: `bun run test` is green and would go **red** on any seam regression.
3. **H2 — release artifacts.** Dockerfile + image scan, the control-plane Helm
   chart, Terraform for GKE + Vault + registry, the release workflow. Demo: the
   plane deploys to a cluster from a pushed image.
4. **H3 — the red-team pass on GKE.** Run the full §7 pass against a real GKE deploy
   with the real NetworkPolicy (`orchestration.md §4`). **This is the exit-gate
   milestone** — a green red-team run on GKE, with the trace pulled by
   `engagement_id`, closes the build.

`H1 + H3` together satisfy the gate; H0 is the enabling spine, H2 the substrate.

---

## 13. Exit gate

> **A red-team pass confirms no inbound path from sandbox to plane other than
> ingest, no secret leaks into logs/harness, and a full dispatch→provision→attack→
> ingest trace is correlated by `engagement_id` on a GKE deploy.**
> (`control-plane.md §12`, Component H.)

Verified by the §7 red-team pass on GKE (H3): the egress + inbound sweeps show only
ingest is reachable inbound and the `overview.md §4.1` DENY set has zero successes
(SEAM 1); the secret sweep shows zero token / model-key leaks in logs or harness env
(SEAM 2); and the trace pulled by `engagement_id` contains the full
dispatch→provision→attack→ingest chain (§5.4). Because §5's tests encode the same
checks in CI (H1), a regression of any seam fails the build *before* it reaches the
red-team pass — the gate is continuously guarded, not a one-time sign-off.

With H green, the build closes: every seam the design has promised since
`overview.md §4` is **enforced and verified**, and the plane is **deployable**, not
just runnable.

---

## 14. Deferred / open questions

- **H-Q1 — full red-team on GKE vs. reduced pass in CI.** The complete §7 pass needs
  a real GKE cluster with the orchestration NetworkPolicy; CI runs a reduced pass on
  kind. If GKE cost/time makes the full pass ad-hoc rather than per-merge, the CI
  kind pass is the continuous guard and the GKE pass is the release gate. Decide the
  cadence at H3.
- **H-Q2 — harness-side `traceparent` emission (cross-repo, confirm before H0).**
  §6.3 propagates trace context through the event stream, which needs the harness to
  stamp the incoming `traceparent` onto emitted events (a small additive contract
  touch, `harness/contracts/`). If the harness cannot be changed in this build, the
  trace still spans dispatch → worker → conductor-spawn (all TS-side); the Python
  interior of the conductor/harness is then a single opaque span rather than fully
  nested. Acceptable degradation; the `engagement_id` correlation across logs +
  metrics + the TS trace holds regardless.
- **H-Q3 — concurrency-cap race hook (inherited from Q2).** `component-q-quota.md §14
  Q2` deferred the race-free concurrency reservation to "H or a small C→Q terminal
  hook." H does not add it: it is a correctness nicety on a *soft* cap, not a
  security seam, and adding a C→Q terminal signal would touch C's write path (which H
  deliberately does not). Left deferred with the streaming-read-path split
  (`control-plane.md §11`).
- **H-Q4 — admin / ops surface.** H adds Grafana dashboards over the metrics +
  traces (the ops view `control-plane.md §11` and `component-q-quota.md §14` both
  flag as missing), but **no** authenticated operator UI inside the plane (per-user
  meters, engagement admin). That remains deferred — the dashboards are read-only
  ops telemetry, not a control surface.
- **H-Q5 — image supply-chain hardening.** Trivy/scout scan + non-root + pinned base
  are in scope (§8.1); SBOM generation, image signing (cosign), and provenance
  attestation are the natural next step, deferred as additive to the release
  workflow.
```
