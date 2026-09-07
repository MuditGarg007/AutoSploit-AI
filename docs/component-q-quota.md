# Component Q — Quota (cross-cutting, `P6`)

> **Status: planning / pre-build (2026-09-06).** Implementation record for the
> quota layer named in `docs/control-plane.md §4 (de-overlap rules), §5, §12`
> (Component Q) and `docs/overview.md §3, §8`. Components 0, A–E are built; this is
> the first of the two cross-cutting layers that ride on top of C and D
> (`control-plane.md §12`: *"Dependency spine: P0 → A → B → C → D → E, with Quota and
> Hardening riding on top once C and D exist."*). Written after Component E; H is the
> only component after this.

---

## 1. One-line job

Stop a user who has already spent (or found) enough from starting yet another
engagement — enforced at `POST /engagements`, **before any job is enqueued**, from
live running totals that a consumer group aggregates off the same `cost`/`finding`
event log the dashboard already streams. Q owns **no metering primitive**: it reads
totals D projects and the per-engagement budget ledger the harness already keeps
(`harness.md §6.2`), and turns their sum into a per-user gate.

---

## 2. Scope of THIS component

**In scope**

- A **per-user meter**: running USD, token, and findings totals, plus a live count
  of non-terminal engagements — aggregated from D's event topic (spend/findings) and
  read through C's API (concurrency).
- **Enforcement at dispatch**: reject `POST /engagements` with `429` when the caller
  is at or over any configured cap, *before* the engagement row is written and the
  BullMQ job enqueued.
- Config-driven caps (spend / findings / concurrency), each independently
  disable-able, defaulting to **off** so the pre-Q behaviour is unchanged until an
  operator sets a cap.

**Out of scope (owned elsewhere)**

- The metering **primitive** — per-response token/USD cost off OpenRouter's `usage`
  and per-turn `cost` events → **harness** (`harness.md §6.2`). Q never computes cost,
  only sums what the harness already emitted.
- Writing / projecting `cost` and `finding` rows → **D · Telemetry** (sole writer,
  `control-plane.md §4.D`). Q is a *new consumer group off the same topic*, never a
  second writer of those tables.
- Engagement state and the `engagements` table → **C · Lifecycle** (sole writer,
  §4.C, §5 rule 1). Q reads the owner and active-count **through C's service API**,
  never its table.
- Billing / invoicing. Q is a *cap*, not a *charge*. The cost basis it reuses is the
  same one billing will later reuse (`overview.md §8`), but money movement is not in
  this build.

Q is **middleware, not a slice** (`control-plane.md §5`): it owns one small store
(the Redis meter, which is a rebuildable projection of the topic, not authoritative
state) and adds one cross-cutting enforcement point. It introduces **no new Postgres
table** and **no new client-facing route**.

---

## 3. Load-bearing decisions

These fix the shape of everything below.

### 3.1 Aggregation is a Kafka **consumer group**, not JVM Kafka Streams

`control-plane.md §4.D / §12` names the aggregator "Kafka Streams (or ksqlDB)". That
is the *conceptual role* — a stateful stream aggregation feeding the meter. The
concrete plane is `kafkajs` on Bun (see `telemetry/kafka/*`), where Kafka Streams
(JVM-only) and ksqlDB (a separate deployment) would both be foreign runtimes. So Q
ships the same aggregation as **one more `kafkajs` consumer group**, identical in
shape to the three that already exist (`sse-bridge`, `projector`, `audit`
consumers), writing its rollup to **Redis** (the store the plane already runs for
the SSE last-mile). This keeps Q inside the one broker + one Redis the plane already
has, and reuses the exact consumer lifecycle wiring (`TelemetryConsumerLifecycle`).

> This is a deliberate, documented reconciliation of `§4.D`'s wording, not a
> silent departure: the *requirement* ("a stateful consumer aggregates running
> totals from `cost` events, independent offset, feeds the dispatch gate") is met;
> the *named technology* is swapped for the one the codebase actually speaks. If a
> JVM stack is ever adopted, the consumer's `handle()` logic ports directly to a
> Streams topology — the Redis key contract (§5) is the seam.

### 3.2 `cost` events carry **running totals**, so aggregation is idempotent

`harness.md §7` freezes the `cost` event as **"token + tool-call running totals"**
(cumulative-so-far for that engagement), and `§6.2` emits one per turn. Q relies on
this: it stores the *latest* running total per engagement and folds only the
**forward delta** into the per-user counter (§6.1). Consequences:

- A **topic replay** (D-b's event-sourcing proof) or a consumer restart re-delivers
  old `cost` events → the delta is `0` (nothing moved past the stored max) → the
  meter is unchanged. Replay-safe **without** tying a Redis write to a Kafka offset
  commit.
- Out-of-order or duplicate delivery cannot inflate the total — the per-engagement
  value is monotonic (`max`), never additive.

> **The one contract to confirm with the harness before building** (§13, Q1): that
> `cost.data` is cumulative, not per-turn delta. The frozen schema says cumulative.
> If it is ever changed to deltas, §6.1 switches from `max`+delta to a plain
> `INCRBY` and **loses replay-idempotency** — the meter would then need offset-tied
> writes or would drift on replay. Building on the running-total contract is what
> keeps Q simple.

### 3.3 Enforce with a global **Interceptor** fired by a route marker

`app.module.ts` already records the intended shape: *"Quota is cross-cutting
middleware (an Interceptor in `core/`), not a domain."* Q honours that literally.

- A `@EnforceQuota()` decorator (`SetMetadata`) marks the one route that must be
  gated — `POST /engagements` in `lifecycle.controller.ts`. The marker lives in
  `core/`, so C importing it is the same allowed direction as C already importing
  `SessionGuard` from `core/guards` — **C does not import the Quota domain.**
- A **global** `QuotaInterceptor` (`APP_INTERCEPTOR`) reads that marker via
  `Reflector`, and on a marked route reads `request.user` (already populated,
  because **interceptors run after guards** in Nest, and `SessionGuard` is the
  route's guard), calls `QuotaService.assertUnderCap(userId)`, and **throws `429`
  before `next.handle()`** — i.e. before the controller runs, before the row is
  written, before `queue.add`. The exit gate's *"before any job is enqueued"* falls
  out of the interceptor position for free.

Why an Interceptor and not a Guard: a global **Guard** runs *before* `SessionGuard`,
so `request.user` would be empty; an Interceptor runs *after* all guards. (The doc
word is "Interceptor" for exactly this reason.) The interceptor throwing short-
circuits `next.handle()`, so the controller body never executes — identical
rejection semantics to a guard, correct ordering.

```
POST /engagements
  └─ SessionGuard (route guard)      → sets request.user            [C, existing]
  └─ QuotaInterceptor (APP_INTERCEPTOR, global)                     [Q, new]
        marker present? → assertUnderCap(user.id)
          over cap → throw 429  ─────────────────────────► REJECT (no row, no job)
          under cap → next.handle()
  └─ LifecycleController.create → dispatch() → row + queue.add      [C, existing]
```

### 3.4 Dependency direction: Q → {C, D}, never the reverse

Q rides on top (`§12` spine). It may import `LifecycleModule` (read owner +
active-count through `LifecycleService`) and use the shared `REDIS`/`KAFKA`
infra. **Nothing in A–E imports the Quota module.** The only touch inside C is the
one-line `@EnforceQuota()` marker imported from `core/` — infra, not domain.

### 3.5 Fail-open, because the harness budget ledger is the hard backstop

If the meter is unreachable at dispatch (Redis or broker down, cold aggregator), Q
**fails open**: dispatch proceeds, and a `warn` log + a metric fire. Justification is
structural, straight from `§5`: *"[Quota] does not own the metering primitive — that
lives in the harness budget ledger."* Every engagement is independently capped by the
harness's own per-engagement `max_tokens` / budget (`harness.md §6.2`), which cannot
be bypassed by a stale plane meter. Q is the **softer, cross-engagement per-user
aggregate** cap on top of that hard per-engagement floor. Blocking all dispatch when
the aggregate meter blips would trade a real availability loss for a benefit the
harness backstop already provides. `QUOTA_FAIL_OPEN=false` is available for an
operator who wants spend-cap-fail-closed regardless (§8).

> Note the asymmetry: the **concurrency** cap is read from C's Postgres (strongly
> consistent, always available when dispatch is), so it does **not** fail open —
> only the Redis/topic-derived spend + findings caps do.

---

## 4. Where Q sits in the flow

```
                 ┌──────────── KAFKA topic (autosploit.events, key=engagement_id) ──────────┐
 D ingest ──────►│  sse-bridge grp   projector grp   audit grp   ┌── quota-aggregator grp ──┐│   [Q, new group]
                 └──────────────────────────────────────────────┼──────────────────────────┘│
                                                                 │ cost + finding events      │
                                                                 ▼                            │
                                                    ┌───────────────────────────┐            │
                                                    │  Redis meter (projection) │◄───────────┘
                                                    │  quota:eng-usd  (hash)    │
                                                    │  quota:usd:user:<id>      │
                                                    │  quota:findings:user:<id> │
                                                    └─────────────┬─────────────┘
                                                                  │ O(1) read
 CLIENT ── POST /engagements ─► SessionGuard ─► QuotaInterceptor ─┤ + countActive(user) via C
                                                                  ▼
                                                  under cap → C.dispatch (row + BullMQ)
                                                  over  cap → 429  (no row, no job)
```

Two independent data paths feed one decision:

- **Spend + findings** (eventually consistent): `cost`/`finding` events → aggregator
  group → Redis counters → read O(1) at the interceptor.
- **Concurrency** (strongly consistent): `LifecycleService.countActive(userId)` reads
  the live count of non-terminal engagements straight from C's table, through C's API.

---

## 5. The Redis meter — key contract

No new Postgres table. The meter is a **projection of the topic**, rebuildable by
replay (like D's `findings`/`cost`), so it lives in Redis beside the SSE last-mile.

| Key | Type | Written by | Meaning | Read at dispatch |
|-----|------|-----------|---------|------------------|
| `quota:eng-usd` | hash `engagementId → usdMicros` | aggregator | latest **running total** USD per engagement (the monotonic max) | no (internal) |
| `quota:eng-tokens` | hash `engagementId → tokens` | aggregator | latest running token total per engagement | no (internal) |
| `quota:usd:user:<userId>` | integer (µUSD) | aggregator | Σ over the user's engagements of latest USD | **yes** |
| `quota:tokens:user:<userId>` | integer | aggregator | Σ tokens for the user | optional |
| `quota:findings:user:<userId>` | set of `"<engagementId>:<sourceId>"` | aggregator | dedup set of the user's finding handles; `SCARD` = count | **yes** (`SCARD`) |
| `quota:owner:<engagementId>` | string `userId` | aggregator cache | resolved owner (immutable), TTL-refreshed | no (internal) |

Design notes:

- The per-engagement hashes exist **only** to make the per-user counter idempotent
  (store the max, fold the delta — §6.1). The per-user integer is what dispatch reads,
  so the read is **O(1)**, not a scan over the user's engagements.
- The findings **set** dedups on the ledger handle `F-001` (`data.id`), exactly the
  key D's projector upserts on — so a replayed `finding` re-`SADD`s the same member
  and `SCARD` is stable. Memory grows with distinct findings per user; acceptable, and
  purgeable per window (§9.5).
- `quota:owner:*` caches C's `ownerOf(engagementId)` so the aggregator resolves each
  engagement's user once (ownership is immutable), not per event.
- Keys are **not** authoritative: dropping the whole `quota:*` namespace and replaying
  the topic (with a fresh owner cache) rebuilds every counter — the same event-sourcing
  property D proves in D-b.

---

## 6. The aggregator consumer

New consumer group `autosploit-quota-aggregator`, own offset, `fromBeginning: true`
(so a cold start rebuilds the meter from the retained topic — the running-total
semantics make that safe). Same skeleton as `ProjectorConsumer` /
`SseBridgeConsumer`: `OnApplicationBootstrap`, `registerConsumer(...)` with
`TelemetryConsumerLifecycle`, null-guarded on `KAFKA`/`REDIS`, never crashes the
group on a bad message.

### 6.1 Per-message logic

```ts
// key = engagement_id (topic partition key); event = { ts, type, data }
async handle({ message }: EachMessagePayload) {
  const engagementId = message.key?.toString('utf8') ?? '';
  const event = parse(message.value);              // ignore non-JSON, never throw
  if (!engagementId || !event) return;

  const userId = await this.ownerOf(engagementId); // cached; C.ownerOf on miss
  if (!userId) return;                             // unknown engagement → skip

  if (event.type === 'cost') {
    // running-total semantics (§3.2): fold only the forward delta.
    const newUsd = Math.round((event.data.usd ?? 0) * 1e6);
    const prevUsd = Number(await redis.hget('quota:eng-usd', engagementId)) || 0;
    if (newUsd > prevUsd) {
      await redis.hset('quota:eng-usd', engagementId, newUsd);
      await redis.incrby(`quota:usd:user:${userId}`, newUsd - prevUsd);
    }
    // identical block for tokens → quota:eng-tokens / quota:tokens:user:<id>
  } else if (event.type === 'finding' && event.data?.id) {
    // set dedups on the ledger handle → replay-idempotent, SCARD = count.
    await redis.sadd(`quota:findings:user:${userId}`, `${engagementId}:${event.data.id}`);
  }
}
```

`ownerOf`: in-memory `Map` → `quota:owner:<id>` Redis string → `LifecycleService.
ownerOf(id)` on a miss, then populate both. Ownership never changes, so the cache is
never invalidated within a process; the Redis copy survives a restart.

### 6.2 Atomicity under horizontal scale

Within **one** aggregator instance the `HGET`→compare→`HSET`+`INCRBY` sequence is
safe because a Kafka consumer processes a partition serially and all events for one
engagement share a partition (key = `engagement_id`). If Q is ever run with **more
than one** aggregator instance in the group, two partitions could touch the same
per-user integer concurrently — `INCRBY` is atomic so the *user* counter stays
correct, but the read-modify-write of `quota:eng-usd` for a single engagement is only
touched by the one partition that owns that engagement, so it is still safe. The
genuinely unsafe case is only if partition assignment moved mid-flight; Kafka's
rebalance protocol commits offsets first, and the running-total `max` makes a
re-processed event a no-op. A **Lua script** doing compare-and-add in one round trip
is the drop-in upgrade if strict single-instance operation is ever not guaranteed
(noted, not built — single aggregator instance is the P6 assumption).

---

## 7. `QuotaService` — the read + decision API

Lives in `core/quota/`. Injects `REDIS`, `EnvService`, and `LifecycleService` (owner
+ active count). Pure reads; it never writes the meter (the aggregator does).

```ts
interface QuotaSnapshot {
  usdMicros: number;      // GET quota:usd:user:<id>
  findings: number;       // SCARD quota:findings:user:<id>
  activeEngagements: number; // LifecycleService.countActive(userId)
}

interface QuotaDecision {
  ok: boolean;
  reason?: 'spend' | 'findings' | 'concurrency';
  snapshot: QuotaSnapshot;
  limits: { usdMicros: number; findings: number; concurrent: number };
}

class QuotaService {
  async snapshot(userId): Promise<QuotaSnapshot>;
  async check(userId): Promise<QuotaDecision>;      // computes ok + reason
  async assertUnderCap(userId): Promise<void>;      // throws 429 on !ok
}
```

- Each cap with value `0` (its env default) is **disabled** and never contributes a
  `reason` — so a fresh deploy with no caps set behaves exactly as today.
- `assertUnderCap` throws `HttpException(429, { error: 'quota_exceeded', reason,
  snapshot, limits })` so the client can render *which* cap and *how far over*.
- **Fail-open (§3.5):** the spend/findings reads are wrapped; if Redis is
  null/unreachable the read yields `null` → treated as "unknown, under cap" when
  `QUOTA_FAIL_OPEN` (default), and a `warn` + counter fire. The **concurrency** read
  goes to Postgres and is *not* wrapped in fail-open — if C's DB is down, dispatch is
  already failing for other reasons.

### 7.1 New read methods on `LifecycleService` (additive, C stays sole writer)

Q needs two reads *through C's API* (never touching the table itself), both pure
`SELECT`s — they do not violate "C is the sole **writer**" (§5 rule 1):

```ts
// engagement → owning user (immutable; the aggregator caches it).
ownerOf(engagementId: string): Promise<string | null>;

// count of the user's non-terminal engagements (concurrency cap input).
// non-terminal = state NOT IN (completed, halted, failed, archived, tearing_down)
countActive(userId: string): Promise<number>;
```

`countActive`'s terminal set matches the state machine (`lifecycle.schema.ts`
`engagementState`): active = `queued | dispatched | provisioning | deploying |
attacking`.

---

## 8. Config — `EnvService` additions

Follows the existing `env.service.ts` conventions (typed, read once, sensible
default). All caps default **off** (`0`), so Q is inert until an operator opts in.

```ts
// --- Quota (Component Q, P6) — per-user caps, all 0 = disabled ---
// µUSD cap on a user's summed engagement spend (e.g. 5_000_000 = $5.00).
readonly quotaMaxUsdMicros = Number(process.env.QUOTA_MAX_USD_MICROS ?? 0);
readonly quotaMaxFindings  = Number(process.env.QUOTA_MAX_FINDINGS  ?? 0);
// Max simultaneous non-terminal engagements per user (overview §3 concurrency cap).
readonly quotaMaxConcurrent = Number(process.env.QUOTA_MAX_CONCURRENT ?? 0);
// Fail-open when the Redis/topic meter is unreachable (harness ledger is the hard
// per-engagement backstop, §3.5). false = block dispatch on an unreachable meter.
readonly quotaFailOpen = (process.env.QUOTA_FAIL_OPEN ?? 'true') !== 'false';
```

Add the four to `.env.example` with the "0 = disabled" note. The spend cap is a
**lifetime** total in this build; a rolling billing-period window is deferred (§13
Q3, `overview.md §8`).

---

## 9. Failure modes & edge cases

1. **Broker / aggregator cold or behind.** Meter reads low or empty → under-cap →
   fail-open dispatch. Acceptable: harness per-engagement budget is the backstop
   (§3.5). Aggregator lag is bounded by consumer throughput; `fromBeginning: true`
   means a cold start converges to the true total, it does not start blank forever.
2. **Redis down.** Spend/findings reads → `null` → fail-open (or block if
   `QUOTA_FAIL_OPEN=false`); concurrency (Postgres) still enforced. Aggregator
   `null`-guards `REDIS` and no-ops, same as `SseBridgeConsumer`.
3. **Topic replay (D-b proof).** Old `cost` events → delta `0`; old `finding`
   events → `SADD` of an existing member. Meter unchanged. Q does not interfere with
   D-b's "drop and rebuild" test, and its own meter is likewise rebuildable.
4. **Concurrency race.** Two `POST /engagements` in the same instant both read
   `countActive = cap-1` and both pass. Window is tiny and the cap is soft; the
   *spend* cap (the money-relevant one) is unaffected. The race-free upgrade is an
   atomic Redis reservation (`INCR quota:active:<user>` at the interceptor, `DECR` on
   terminal) — deferred because it needs a terminal-state signal Q would have to
   subscribe to, and engagement state is deliberately **not** on the topic (§5 rule 3,
   D never writes state). Documented as the known limit (§13 Q2), not silently
   ignored.
5. **Findings-set growth.** `quota:findings:user:<id>` grows with distinct findings.
   Bounded per user, purgeable when a window resets (§13 Q3). For a lifetime cap it is
   retained; acceptable at expected volumes.
6. **Unknown engagement in aggregator.** `ownerOf` miss (event for an engagement C
   has no row for — should not happen post-dispatch) → skip the event, no crash.
7. **Cap set below a user's existing total.** An operator lowers a cap under a user
   already above it → that user is blocked from new engagements until the window
   resets or the cap rises. Correct behaviour; surfaced in the `429` snapshot so it is
   diagnosable.

---

## 10. Testing plan (maps 1:1 to the exit gate)

New spec `control-plane/test/quota.spec.ts`, Testcontainers Postgres + Redis +
Redpanda (mirrors `telemetry-durable.spec.ts` / `telemetry.spec.ts`).

1. **Over-cap rejected before enqueue (the gate).** Set `QUOTA_MAX_USD_MICROS`;
   produce `cost` events on the topic for a user's engagement summing over the cap;
   wait for the aggregator to converge; `POST /engagements` → **`429
   quota_exceeded reason=spend`**, and assert the **BullMQ queue job count is
   unchanged** and **no new `engagements` row** was written — "before any job is
   enqueued" proven, not assumed.
2. **Under cap passes.** Same setup below the cap → dispatch succeeds, row `queued`.
3. **Idempotent on replay.** Produce the same `cost` events twice (and restart the
   aggregator) → `quota:usd:user:<id>` equals the single-pass total (running-total
   `max`), cap decision identical.
4. **Findings cap.** Produce N distinct `finding` events (+ a duplicate handle) →
   `SCARD` counts N (dedup proven) → over `QUOTA_MAX_FINDINGS` → `429 reason=findings`.
5. **Concurrency cap.** `QUOTA_MAX_CONCURRENT`; leave that many engagements in a
   non-terminal state → next `POST` → `429 reason=concurrency`; drive one terminal →
   next `POST` passes.
6. **Fail-open.** Point Redis at a dead port (or disable) with a cap set + default
   `QUOTA_FAIL_OPEN` → dispatch **succeeds**, a `warn` is logged; flip
   `QUOTA_FAIL_OPEN=false` → dispatch **blocked** with a meter-unavailable `429`.
7. **Caps off = no-op.** All caps `0` → arbitrary spend → dispatch always passes;
   confirms zero behaviour change on a default deploy.

Unit tests: `QuotaService.check` truth table across the three caps and the
`0=disabled` path; aggregator `handle()` delta math (running-total forward-only) and
the finding dedup.

---

## 11. File-by-file change list

**New (`control-plane/src/core/quota/`):**

- `quota.module.ts` — `@Global()`; imports `LifecycleModule` + `RedisModule` +
  `TelemetryModule`; provides `QuotaService`, `QuotaAggregatorConsumer`, and
  `{ provide: APP_INTERCEPTOR, useClass: QuotaInterceptor }`. *(Build reconciliation:
  the aggregator injects the `KAFKA` client + `TelemetryConsumerLifecycle`, which are
  D-slice providers — so `TelemetryModule` exports those two tokens and Q imports
  the module. Additive exports only; no telemetry logic changed.)*
- `quota.service.ts` — `snapshot` / `check` / `assertUnderCap` (§7).
- `quota-aggregator.consumer.ts` — the new consumer group (§6); registers with
  `TelemetryConsumerLifecycle` for clean shutdown.
- `quota.interceptor.ts` — global `APP_INTERCEPTOR`; `Reflector` reads the marker,
  reads `request.user`, calls `assertUnderCap`, throws `429` before `next.handle()`
  (§3.3).
- `enforce-quota.decorator.ts` — `export const EnforceQuota = () =>
  SetMetadata('enforce-quota', true)`.

**Edited (small, additive):**

- `config/env.service.ts` — the four `quota*` fields (§8).
- `.env.example` — document the four vars.
- `domains/lifecycle/lifecycle.service.ts` — add `ownerOf` + `countActive` reads
  (§7.1). **No change to any write path**; C stays sole writer of state.
- `domains/lifecycle/lifecycle.controller.ts` — one line: `@EnforceQuota()` on
  `create()` (marker imported from `core/quota`, same import direction as the existing
  `SessionGuard` import).
- `domains/telemetry/telemetry.module.ts` — additive: export `KAFKA` +
  `TelemetryConsumerLifecycle` for Q's aggregator (see `quota.module.ts` above).
- `app.module.ts` — register `QuotaModule` after `TelemetryModule`; the existing
  "Quota is cross-cutting middleware (an Interceptor in core/)" comment becomes true.

**Untouched (proof of the boundary):** every `domains/telemetry/*` consumer,
provider, and schema file — only `telemetry.module.ts` gains the two additive
token exports above. Q is a *new consumer group* off the existing topic and a
*reader* of the existing meter events, adding **no** writer to `cost`/`findings`
and **no** new topic.

---

## 12. Build order (sub-milestones, each demoable)

1. **Q0 — config + reads.** `EnvService` caps; `LifecycleService.ownerOf` +
   `countActive` with unit tests. Nothing enforces yet.
2. **Q1 — aggregator.** The consumer group + Redis meter; assert via a test that
   produced `cost`/`finding` events converge to the right `quota:*` values and are
   replay-idempotent. Meter is live, still no enforcement.
3. **Q2 — service + interceptor.** `QuotaService.check`, the `QuotaInterceptor`, the
   `@EnforceQuota()` marker on `create()`. **Enforcement lights up here** — this is
   the exit-gate milestone.
4. **Q3 — fail-open + concurrency + polish.** Fail-open wrapping, the concurrency
   cap wired through `countActive`, the full `quota.spec.ts`, `.env.example`.

`Q2` alone satisfies the gate; `Q3` closes the edges.

---

## 13. Exit gate

> **A user at their cap is rejected at `POST /engagements` before any job is
> enqueued, and the rejection reflects live totals aggregated from `cost` events —
> cap enforced at C, computed in D, primitive still owned by the harness.**
> (`control-plane.md §12`, Component Q.)

Verified by test 1 (§10): with a spend cap set and `cost` events produced on the
topic pushing a user over it, `POST /engagements` returns `429 reason=spend` while
the **BullMQ job count and `engagements` row count are both unchanged** — "before any
job is enqueued", checked not assumed. "Computed in D" = the totals come from the
aggregator group off D's topic; "primitive owned by the harness" = Q sums `cost`
events, it never computes cost; "enforced at C" = the rejection lands on C's dispatch
route via the interceptor.

---

## 14. Deferred / open questions

- **Q1 — `cost` event semantics (blocking, confirm before Q1).** §3.2 builds on
  `cost.data` being a **cumulative running total** (per `harness.md §7`), which makes
  aggregation replay-idempotent. Confirm the harness emits cumulative, not per-turn
  delta. If delta: switch §6.1 to `INCRBY` and add offset-tied writes or accept
  replay drift.
- **Q2 — concurrency-cap race (known limit).** The concurrency check reads
  `countActive` and has a tiny check-then-act window (§9.4). Race-free upgrade =
  atomic Redis reservation with a terminal-state release, which needs a state signal
  Q would subscribe to; engagement state is deliberately off the topic (§5 rule 3), so
  this is deferred to H or a small C→Q terminal hook. The money-relevant **spend** cap
  is unaffected.
- **Q3 — window / reset.** Caps are **lifetime** totals in this build. Billing-period
  windows (monthly reset, `overview.md §8`) need a keyed-by-window meter
  (`quota:usd:user:<id>:<yyyy-mm>`) and a purge of the per-engagement hashes + findings
  set on roll-over. Additive to the key contract (§5), deferred.
- **Q4 — multi-instance aggregator.** Single instance is the P6 assumption; the Lua
  compare-and-add upgrade (§6.2) is the path to horizontal scale, deferred with the
  streaming-read-path split (`control-plane.md §11`).
- **Admin surface.** No operator view of per-user meters yet (same gap as
  `control-plane.md §11` "Admin / ops surface"); the `429` snapshot is the only
  current window into a user's totals.
