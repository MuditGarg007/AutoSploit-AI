# Autosploit — API / Control Plane (spec)

> **Status: planning / pre-build (2026-08-11).** Design record for overview plane 2
> (`docs/overview.md §3`). The attack engine (`harness/`), target provisioner
> (`provisioner/`), and conductor (`conductor/`) are built; this layer wraps them
> with auth, persistence, a job queue, and a live event fan-out so that *many*
> engagements run safely for *many* users. Architecture is settled below; the
> concrete library-level tech stack (§9) is deliberately left open pending a
> separate decision.

---

## 1. One-line job

Turn "a logged-in user picked a repo" into "an engagement ran, streamed live, and
left a report" — for many users at once — without ever holding untrusted code or
reaching into a sandbox.

---

## 2. Scope of THIS component

**In scope**

- GitHub OAuth login + consent record; per-user scoping.
- Repo listing + deployable-flag probe (feeds the picker).
- Engagement lifecycle: create → queue → run → terminal → teardown, as the single
  system of record (replaces the conductor's `conductor.json`).
- Ingesting the harness event stream, persisting findings/cost, fanning events to
  the right client over SSE.
- Assembling and serving the final report.

**Out of scope (owned elsewhere)**

- Deploying the target / building untrusted repos → **provisioner** (untrusted).
- Running the agent loop, holding the model key → **conductor + harness** (trusted).
- Isolation runtime, egress policy, k8s namespaces → **orchestration** (`orchestration.md`).

The control plane is **trusted code that never touches untrusted input**: it holds
the GitHub token vault and mints per-engagement credentials, but the repo bytes and
the model key never enter it. It talks to the sandbox through exactly one inbound
edge — events pushed *up* — and never reaches *down* into a running engagement.

---

## 3. Load-bearing decisions (settled)

These four shape everything below and are fixed:

1. **Modular monolith, not microservices.** One deployable, five internal slices
   (§4) with hard table-ownership boundaries. Refactor a slice out later only if a
   real scaling need appears (the streaming read-path is the likely first candidate).
2. **Client live feed is SSE.** Server→client one-way is exactly the event feed;
   plain HTTP, native auto-reconnect + `Last-Event-ID` for backlog replay. Dashboard
   controls (create/abort) go over ordinary REST, not the stream.
3. **The event stream is split by requirement — Kafka backbone, Redis last-mile.**
   The engagement telemetry has two very different jobs, so two tools own them
   (§8.2): a **Kafka-API log** (Redpanda) is the durable, replayable system-of-record
   with independent consumer groups + Schema Registry enforcing the event contract;
   **Redis Streams** is only the sub-second last-mile that feeds SSE. This reverses
   `orchestration.md §3.1`'s Kafka rejection — justified *only* because the stream now
   has multiple independent consumers (SSE bridge, Postgres projector, S3 sink, audit,
   quota aggregation), not one. Were it SSE-only, Kafka would be forced.
4. **The sandbox pushes up; the control plane never reaches down.** The only inbound
   edge from an engagement is the authenticated event POST (`overview.md §4.1`
   egress matrix). This is a security control, not a style choice.

---

## 4. The five vertical slices

Each slice is one bounded context: it owns its own tables, has a **single writer**,
exposes one client-facing capability, and ships as its own module + migration.

| Slice | Owns (tables / streams) | Client API | Sole writer of |
|-------|-------------------------|-----------|----------------|
| **A · Identity** | `users`, `sessions`, `github_tokens` (encrypted at rest) | `GET /auth/github`, `/auth/callback`, `/me` | user records + token vault |
| **B · Repos** | `repo_cache` (optional) | `GET /repos`, `GET /repos/:id/deployable` | cache only |
| **C · Lifecycle** | `engagements` (+ state machine) | `POST /engagements`, `GET /engagements`, `POST /engagements/:id/abort` | **engagement state — the only writer** |
| **D · Telemetry** | `events` (Kafka topic + Redis last-mile), `findings`, `cost` | `GET /engagements/:id/stream` (SSE) | events / findings / cost |
| **E · Reports** | `reports` + object-store refs | `GET /engagements/:id/report` | report artifacts |

### 4.A Identity
GitHub OAuth handshake (login **is** the consent record — `overview.md §2`), session
issuance, and the **GitHub-token vault**: the user's access token, encrypted at rest,
is what the provisioner later needs to clone a private repo. Nothing outside this
slice writes a user or a token.

### 4.B Repos
Read-through proxy to the GitHub API: list the user's repos and flag which are
**deployable** (probe for `docker-compose.yml` / `Dockerfile` — the §2.1 ladder gate).
Depends on A for the token. Holds no authoritative state.

### 4.C Lifecycle
The core write path. Collapses what a naive design splits into dispatcher + queue +
worker + engagement-store into **one** slice, because they all mutate one thing —
engagement state. Owns:

- **Dispatch** (`POST /engagements`): validate ownership + deployable, enforce quota,
  write the row as `queued`, mint a per-engagement **ingest token**, decrypt the
  GitHub token for the job, enqueue.
- **Worker**: dequeue → run the engagement via the conductor (Phase A: subprocess;
  Phase B: create a k8s Job) → drive every state transition from the process /
  Job outcome.
- **State machine** (§7): the authoritative lifecycle, replacing `conductor.json`.

Every state flip goes through here. No other slice touches `engagements`.

### 4.D Telemetry
Ingest **and** SSE fan-out are the *same* slice, because they own one event log —
splitting them would put the writer and reader of one stream in two services, the
exact overlap this design removes. Internally the log is split by requirement (§8.2):
a Kafka topic is the durable backbone, Redis Streams the SSE last-mile.

- **Ingest** (write end): one authenticated endpoint eating the frozen
  `{ts, type, data}` stream (`harness.md §7`), validated against Schema Registry, and
  **produced to the Kafka topic** (partition key = `engagement_id`). Ingest itself
  does not write Postgres — the projector consumer does (below).
- **Consumer groups** off the topic, each with its own offset:
  - **SSE bridge** → pushes each engagement's events into a short-retention Redis
    Stream, which the gateway tails.
  - **Postgres projector** → projects `finding` / `cost` events into the tables
    (these tables are a *projection* of the log — rebuildable by replay).
  - **S3 sink** (Kafka Connect) → archives raw events to the object store.
  - **audit** → immutable retained trail of every tool call (security record).
  - **quota aggregation** (Kafka Streams) → cost/findings rollups feeding the meter.
- **SSE gateway** (read end): client subscribes by `engagement_id`; authorize
  ownership, replay recent backlog from the Redis last-mile, then tail live.

Telemetry **never writes engagement state** (see §5, rule 3).

### 4.E Reports
Assembles the final report from `findings` plus object-store artifacts (memory
bundle, raw JSONL log, rendered report), serves the viewer and downloads. Triggered
by C reaching a terminal state. Read-only over D.

---

## 5. The de-overlap rules

The invariants that keep the slices from bleeding into each other:

1. **One writer per table.** The whole point of the cut.
2. **Lifecycle owns all authoritative state transitions.** The worker is Lifecycle's
   execution arm, not a separate service. `queued → provisioning → attacking →
   {completed | halted | failed} → torn_down` — every flip is driven by the conductor
   process / k8s-Job outcome that Lifecycle is watching.
3. **Telemetry never writes engagement state.** It persists events / findings / cost
   and fans them out; it does not flip `completed`. Two different notions of "state",
   blessed by the docs, so they never fight over one field:
   - **authoritative state** → Lifecycle, from the process exit / `RunResult`.
   - **cosmetic phase** (`recon` / `exploit`) → Telemetry, agent self-declared,
     "emitted, never enforced" (`harness.md §7`).
4. **Ingest + SSE are one slice, not two.** They share the per-engagement event log;
   ingest is the write end, the SSE gateway the read end, one bounded context.

Quota is **cross-cutting middleware**, not a slice: it enforces at C's dispatch off
running totals, which a Kafka Streams consumer aggregates from D's `cost` events
(§4.D). It does not own the metering primitive — that lives in the harness budget
ledger (`harness.md §6.2`).

---

## 6. Flow / architecture

```
CLIENT ─┬─ OAuth redirect ─────────► A Identity
        ├─ GET /repos ────────────► B Repos ──(token)──► A
        ├─ POST /engagements ─────► C Lifecycle ─► BullMQ ─► worker ─► CONDUCTOR
        ├─ GET /:id/stream (SSE) ◄─ D gateway ◄─ Redis(last-mile) ◄─ SSE-bridge ◄─┐
        └─ GET /:id/report ───────► E Reports ── reads ─► D + object store         │
                                                                                   │
  CONDUCTOR stdout   (Phase A) ─┐                                    KAFKA topic ──┤
  ATTACKER POD       (Phase B) ─┴─► D ingest ─(Schema Registry)─► (engagement_id) ─┼─► Postgres projector
                                    egress matrix: sandbox → CP, events ONLY       ├─► S3 sink (Connect)
                                                                                   ├─► audit trail
                                                                                   └─► quota agg (Streams)
```

Two seams matter most:

- **Sandbox is never reached into.** It pushes events to ingest. The endpoint is
  designed dual-source from day one: the Phase-A worker relays the conductor's stdout
  to it, and the Phase-B attacker pod POSTs to it directly — **the ingest endpoint
  never changes** between the two.
- **The secret split stays intact.** The GitHub token flows vault (encrypted, A) →
  Lifecycle decrypts at dispatch → provisioner env for clone only, never logged,
  never to the harness. The `OPENROUTER_API_KEY` stays conductor-only and never
  enters the control plane (`orchestration.md §2` trust boundary).

---

## 7. Engagement state machine

Maps 1:1 to the conductor's `RunResult` / `ProvisionOutcome`, and is the
control-plane replacement for `conductor.json`:

```
queued → dispatched → provisioning → deploying → attacking
   → { completed
     | halted[budget | scope | timeout]
     | failed[provision | harness | internal] }
   → tearing_down → archived
```

Lifecycle is the sole writer of this field. Terminal outcomes are derived from the
conductor exit code + record, not guessed from the event stream.

---

## 8. Cross-slice contracts (the only coupling)

No slice reads another's tables. The three seams between them:

1. **C mints, D validates.** Lifecycle mints a per-engagement ingest token at
   dispatch (short-lived, signed, scoped to one `engagement_id`); Telemetry validates
   its signature. Shared signing key, zero runtime call between them. Fail-closed.
2. **C → conductor.** The worker shells `conductor run <repo> --engagement-id <id>`
   (Phase A) or creates a k8s Job (Phase B) — the frozen provisioner + harness CLIs.
3. **E reads D.** Reports reads `findings` and pulls artifacts from the object store;
   triggered by C's terminal transition.

### 8.1 The Python ⇄ TypeScript border

The harness emits JSONL; this layer consumes it. The border is frozen as data, not
code: the event schema is the source of truth (`harness/contracts/`), and the control
plane **generates its types from that schema** rather than hand-mirroring it. Both
Phase A (worker parses conductor stdout, validates each line, produces to the topic)
and Phase B (attacker pod produces directly) meet the same schema at the same ingest.

**Schema Registry makes the border broker-enforced, not just codegen.** The frozen
`harness/contracts/` schema is registered; the Python producer side and the TS
consumer groups bind to it, and the broker rejects any event that does not conform.
This is the least-forced Kafka integration — the polyglot contract was already the
problem, and a registry is the tool built for it. Compatibility rules on the registry
(backward-compatible only) also police future MINOR contract bumps (`harness.md §5`).

### 8.2 Event-stream split — Kafka backbone vs Redis last-mile

The engagement telemetry does two jobs with opposite requirement profiles, so two
tools own them rather than overloading one (this is the CQRS/event-sourcing split, not
padding):

| Job | Requirement profile | Tool |
|-----|---------------------|------|
| Durable system-of-record log | long retention, replay, many independent consumer groups, cross-language schema | **Kafka-API log (Redpanda)** |
| Live push to the browser | sub-second latency, short retention, reconnect window | **Redis Streams (last-mile)** |

The Kafka log is the source of truth; the Postgres `findings`/`cost` tables are
**projections** rebuildable by replaying the topic (event sourcing). The boundary that
keeps this defendable: adopt Kafka **only because** the stream has multiple independent
consumers (SSE bridge, projector, S3 sink, audit, quota) — an SSE-only stream would
not justify it, and `orchestration.md §3.1` was right to reject it under that narrower
requirement. Dispatch stays on **BullMQ**, never Kafka: a log is not a work queue (no
per-message ack / retry / visibility).

---

## 9. Tech stack

Chosen through one lens (the same as `orchestration.md §3`): **every tool must map to
a requirement this app actually has.** The resume value is real precisely because each
pick answers a need — and the *rejected* list (§9.2) is as load-bearing as the chosen
one.

### 9.1 Chosen

| Layer | Pick | Requirement it answers |
|-------|------|------------------------|
| Runtime / language | TypeScript · Node 22 | client's language; the "TS control plane" seam (`harness.md §7`) |
| Monorepo | Bun workspaces · Turborepo | client + control plane share the generated event types (the §8.1 border); Bun is package manager + workspace tool only — **runtime stays Node 22** (NestJS/Fastify + BullMQ/ioredis proven there) |
| Framework | **NestJS** (Fastify adapter) | Nest modules map 1:1 to the five slices; DI enforces boundaries, Guards = auth, Interceptors = quota + telemetry; Fastify adapter keeps native SSE |
| API contract | **tRPC** (`nestjs-trpc`) | end-to-end type-safe commands across the monorepo; **SSE stays a raw Nest route**, never a tRPC subscription |
| ORM / migrations | **Drizzle** (`drizzle-kit`) | SQL-first typed access + row-level user scoping; migrations in CI. Wrapped in a `DrizzleModule` provider |
| DB | Postgres | multi-tenant system of record |
| Queue | BullMQ (Redis) | durable dispatch → worker, retries, concurrency caps |
| **Event backbone** | **Redpanda** (Kafka API) | durable, replayable system-of-record log; independent consumer groups partitioned by `engagement_id` (§8.2). Single binary, no ZooKeeper — light enough for a personal GKE deploy |
| Stream contract | **Schema Registry** (Redpanda built-in) | broker-enforces the frozen `harness/contracts/` event schema across the Python↔TS border (§8.1) |
| Stream sink | **Kafka Connect** — S3 sink | archives raw events to the object store, no custom archiver |
| Stream processing | **Kafka Streams** (or ksqlDB) | cost/findings rollups feeding the quota meter (§5) |
| SSE last-mile | Redis Streams (ioredis) | sub-second per-`engagement_id` push to the SSE gateway (§8.2) |
| Object store | S3 / MinIO (AWS SDK v3) | reports / logs / memory bundles; presigned download URLs |
| Auth | Passport (GitHub OAuth) + JWT (`jose`) | OAuth handshake + short-lived access / httpOnly refresh |
| **Token vault** | **HashiCorp Vault** — Transit engine, **k8s auth method** | users' GitHub tokens (private-repo read) encrypted at rest; the app holds ciphertext only and never the key; pod service-account authenticates to Vault (no bootstrap secret) |
| Contract validation | Schema Registry (broker) + generated TS types | conformance enforced at the broker, types generated for consumers from the same schema |
| Observability | OpenTelemetry · Prometheus · Grafana · Pino | domain-native: trace dispatch → provision → attack → ingest correlated by `engagement_id` |
| Testing | Vitest · Supertest · Testcontainers | real Postgres/Redis in CI, not mocks |
| Platform | Docker · GKE · Helm · Terraform · GH Actions → GHCR | shared with `orchestration.md §3`; each primitive maps to a requirement |

Two integration wrinkles, both by design:

- **tRPC is not native to NestJS.** Bridged via `nestjs-trpc` (decorator-based, keeps
  DI) or a plain tRPC router mounted as middleware with Nest services in
  `createContext`. Consequence accepted: TS-only clients — the dashboard is the only
  consumer.
- **Vault auth is a design point, not a footnote.** Terraform provisions the Transit
  engine + policy; the app authenticates with its Kubernetes service-account token via
  Vault's k8s auth method, so there is no static bootstrap secret to leak.

### 9.2 Deliberately NOT

Tempting resume tech with no matching requirement here — rejected on purpose:

- **GraphQL** — a few resources + one SSE stream; no nested read-graph to justify it.
- **Temporal** — the **conductor already owns** the provision → attack → teardown saga;
  a second workflow engine would compete with it.
- **Microservices** — modular monolith; the SSE read-path is the first slice to split
  out, and only on a real scaling signal.
- **gRPC to the client** — browser consumer; REST/tRPC + SSE fits.

**Kafka was on this list and moved to §9.1** once the requirement changed: the event
stream gained multiple independent consumers (§8.2). The reversal is the point — it
stays defendable *because* it is tied to a requirement that now exists, and would go
back on this list the moment the stream collapsed to SSE-only.

---

## 10. Build order (this component)

Sits at `overview.md §6` step 2 (wrap the proven vertical slice with a control plane).
Sub-milestones, each demoable standalone, built A→E:

1. **P0 — Scaffold.** Monolith skeleton, Postgres schema + migrations, health check.
2. **P1 — Identity (A).** GitHub OAuth + session + encrypted token vault.
3. **P2 — Repos (B).** Repo listing + deployable-flag probe → picker API.
4. **P3 — Lifecycle (C).** Engagement CRUD + state machine + dispatch + queue +
   worker shelling the conductor. *(single node; ingest still unauthed.)*
5. **P4 — Telemetry (D).** Split in two sub-steps so the dashboard is not gated on
   the broker:
   - **P4a** — ingest → Kafka (Redpanda) with Schema Registry; SSE-bridge consumer →
     Redis last-mile → SSE gateway (replay + live). **The dashboard lights up here.**
   - **P4b** — the remaining consumer groups: Postgres projector, S3 sink (Connect),
     audit trail. Adds durability/replay without touching the live path.
6. **P5 — Reports (E).** Report assembly + object store.
7. **P6 — Quota.** Kafka Streams cost aggregation + cap enforcement at dispatch.

P3 + P4 are the spine — where "many engagements, streamed live" becomes real. P4a is
enough to demo; P4b + P6 are where the event-sourcing/streaming story pays off.

---

## 11. Deferred / known limits

- **Quota / billing (P6).** Reuses the harness budget primitive; can slip to the
  overall build order's step 4 without blocking the demo.
- **Streaming read-path split.** The SSE gateway is the first slice likely to move
  out of the monolith if connection scaling demands it — designed as a clean read
  end of D to make that cheap.
- **Multi-service compose targets.** More than one target host is an additive scope
  change owned by the provisioner (`orchestration.md §4.1`); the control plane's
  engagement model already keys everything by `engagement_id`, so it is unaffected.
- **Admin / ops surface.** No internal dashboard for operators yet.

---

## 12. Roadmap — per-component scope + exit gate

The build is cut into **eight components**: one scaffold, the five vertical slices
(§4), and two cross-cutting layers (quota, hardening). Each is demoable standalone and
built in order. For every component below: **Scope** (what it delivers), **Details**
(the load-bearing pieces inside it), and the **Exit gate** — the single, checkable
condition that declares the component *finished*. A component is not "done" until its
gate is green; the gate is the contract the next component builds on.

Dependency spine: `P0 → A → B → C → D → E`, with **Quota** and **Hardening** riding on
top once C and D exist.

---

### Component 0 — Scaffold (`P0`)

- **Scope.** The empty-but-running monolith: one deployable, wired build, migrations, a
  health check. No business logic.
- **Details.**
  - Bun workspace + Turborepo; client and control plane share the generated
    event-type package (§8.1 border).
  - NestJS (Fastify adapter) skeleton with the five empty slice modules registered.
  - Postgres up via Testcontainers in CI; Drizzle schema + first migration; `DrizzleModule` provider.
  - `GET /health` returns liveness + DB connectivity.
- **Exit gate.** `bun run build && bun run test` green in CI, migrations apply from clean, and
  `GET /health` returns `200` with a live DB check — proven against a real Postgres in
  CI, not a mock.

---

### Component A — Identity (`P1`)

- **Scope.** A user can log in with GitHub and the system holds an encrypted vault of
  their access token. Sole writer of `users`, `sessions`, `github_tokens`.
- **Details.**
  - GitHub OAuth handshake (login **is** the consent record); `GET /auth/github`,
    `/auth/callback`, `/me`.
  - Session issuance: short-lived JWT access + httpOnly refresh (`jose`).
  - **Token vault**: GitHub token encrypted at rest via Vault Transit; app holds
    ciphertext only. Pod authenticates to Vault with its k8s service-account token — no
    static bootstrap secret.
- **Exit gate.** A fresh user completes the OAuth round-trip, `/me` returns their
  identity from a valid session, and their GitHub token is persisted as **ciphertext**
  (verified: plaintext never lands in Postgres or logs) and decryptable only through
  Vault.

---

### Component B — Repos (`P2`)

- **Scope.** The picker API: list the user's repos and flag which are deployable.
  Holds no authoritative state.
- **Details.**
  - Read-through proxy to the GitHub API, using A's token; `GET /repos`,
    `GET /repos/:id/deployable`.
  - Deployable probe = presence of `docker-compose.yml` / `Dockerfile` (the §2.1 ladder gate).
  - Optional `repo_cache` (cache only; sole writer of it).
- **Exit gate.** `GET /repos` returns the authenticated user's repos, and
  `/repos/:id/deployable` correctly flags a known-deployable repo `true` and a
  non-deployable one `false` — token sourced from A, no repo bytes entering the plane.

---

### Component C — Lifecycle (`P3`)

- **Scope.** The core write path and system of record for engagements. Create → queue →
  run → terminal → teardown. **Sole writer of `engagements`** — replaces `conductor.json`.
- **Details.**
  - **Dispatch** (`POST /engagements`): validate ownership + deployable, enforce quota/
    hook, write row `queued`, mint per-engagement ingest token, decrypt GitHub token for
    the job, enqueue on BullMQ.
  - **Worker**: dequeue → shell `conductor run <repo> --engagement-id <id>` (Phase A
    subprocess) → drive every state flip from the process/`RunResult` outcome.
  - **State machine** (§7): `queued → dispatched → provisioning → deploying → attacking →
    {completed | halted | failed} → tearing_down → archived`; the authoritative field.
  - `GET /engagements`, `POST /engagements/:id/abort`.
  - *Ingest still unauthed at this milestone (closed in D).*
- **Exit gate.** `POST /engagements` on a deployable repo runs the conductor end-to-end
  on a single node and lands the row in a **terminal state derived from the conductor
  exit code** (not guessed from events); `abort` halts a running engagement; every state
  transition is written only by Lifecycle.

---

### Component D — Telemetry (`P4`)

Split into two gates so the dashboard is not blocked on the broker.

- **Scope.** One event log, both ends: authenticated ingest of the harness stream, and
  live SSE fan-out to the owning client. Sole writer of `events`, `findings`, `cost`.
  **Never writes engagement state** (§5 rule 3).

- **D-a — live path (`P4a`).**
  - **Details.** Authenticated ingest endpoint eating the frozen `{ts, type, data}`
    stream, validated against Schema Registry, produced to the Redpanda topic (key =
    `engagement_id`). SSE-bridge consumer → Redis last-mile Stream → `GET /:id/stream`
    gateway with ownership auth, `Last-Event-ID` backlog replay, then live tail.
  - **Exit gate.** A running engagement's events reach a subscribed browser over SSE in
    sub-second, ingest **rejects an unsigned/mis-scoped token and a schema-violating
    event** (fail-closed), and a reconnect with `Last-Event-ID` replays the missed
    backlog. **Dashboard lights up here.**

- **D-b — durable consumers (`P4b`).**
  - **Details.** Remaining consumer groups off the topic, each with its own offset:
    Postgres projector (`finding`/`cost` as rebuildable projections), S3 sink (Kafka
    Connect), audit trail (immutable tool-call record).
  - **Exit gate.** `findings`/`cost` tables can be **dropped and fully rebuilt by
    replaying the topic** (event-sourcing proof), raw events land in the object store,
    and every tool call appears in the immutable audit trail — all without touching the
    live SSE path.

---

### Component E — Reports (`P5`)

- **Scope.** Assemble and serve the final report. Read-only over D; triggered by C's
  terminal transition. Sole writer of `reports`.
- **Details.**
  - Assembles from `findings` + object-store artifacts (memory bundle, raw JSONL log,
    rendered report); `GET /engagements/:id/report`.
  - Presigned download URLs (S3/MinIO, AWS SDK v3).
- **Exit gate.** On an engagement reaching a terminal state, `GET /:id/report` serves the
  assembled report to its owner and every artifact downloads via a working presigned URL
  — with no write-back into D's tables.

---

### Component Q — Quota (`P6`, cross-cutting)

- **Scope.** Enforce per-user cost/findings caps at dispatch. Middleware, **not a
  slice** — owns no metering primitive.
- **Details.**
  - Kafka Streams (or ksqlDB) consumer aggregates running totals from D's `cost` events.
  - C's dispatch reads those totals and rejects over-cap creates. Metering primitive
    stays the harness budget ledger (`harness.md §6.2`).
- **Exit gate.** A user at their cap is rejected at `POST /engagements` before any job
  is enqueued, and the rejection reflects live totals aggregated from `cost` events — cap
  enforced at C, computed in D, primitive still owned by the harness.

---

### Component H — Hardening / release (cross-cutting, closes the build)

- **Scope.** The two security seams proven under adversarial conditions, plus deploy.
- **Details.**
  - **Egress matrix** enforced: the sandbox reaches the plane on exactly one edge
    (event POST); the plane never reaches down (§3 rule 4, `overview.md §4.1`).
  - **Secret split** proven: GitHub token vault→dispatch→provisioner-clone-only, never
    logged, never to the harness; `OPENROUTER_API_KEY` never enters the plane.
  - Phase-B parity: the attacker pod POSTs the **same ingest endpoint** the Phase-A
    worker relays to — endpoint unchanged across phases.
  - OTel/Prometheus/Grafana/Pino traces correlated by `engagement_id`; Helm + Terraform
    + GH Actions → GHCR deploy.
- **Exit gate.** A red-team pass confirms no inbound path from sandbox to plane other
  than ingest, no secret leaks into logs/harness, and a full dispatch→provision→attack→
  ingest trace is correlated by `engagement_id` on a GKE deploy.

---

### Roadmap at a glance

| # | Component | Delivers | Exit gate (one line) |
|---|-----------|----------|----------------------|
| P0 | Scaffold | Running empty monolith | CI green + migrations + `/health` on real Postgres |
| A | Identity | GitHub login + token vault | OAuth round-trip; token stored as ciphertext only |
| B | Repos | Deployable-flag picker | `/repos` + correct `deployable` flag, no repo bytes |
| C | Lifecycle | Engagement system-of-record | Conductor run → terminal state from exit code; abort works |
| D-a | Telemetry (live) | SSE fan-out | Sub-second SSE + fail-closed ingest + backlog replay |
| D-b | Telemetry (durable) | Consumer groups | Tables rebuildable by topic replay; audit + S3 sink |
| E | Reports | Report assembly | Report + presigned artifacts served to owner |
| Q | Quota | Cap enforcement | Over-cap create rejected at dispatch from live totals |
| H | Hardening | Seams + deploy | Red-team: only ingest inbound, no secret leaks, traced on GKE |

**P3 + P4a are the spine** — where "many engagements, streamed live" becomes real and
demoable. D-b, Q, and H are where the event-sourcing / security story pays off.
