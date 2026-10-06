# Deferred / Open Items

> **Date: 2026-09-15.** Consolidated register of everything deliberately deferred or
> left open across the build. Sourced from the per-component design records; each item
> links back to its home doc and section. This is a tracking index, not a re-decision —
> the linked doc remains the authority for the reasoning behind each deferral.

---

## Priorities (2026-09-15)

Triage of the items below into what to act on soon versus what can safely wait.

### Do soon

1. **~~Confirm `cost` event semantics (Q1).~~ CONFIRMED 2026-09-15.** The harness emits
   cumulative running totals — `meter_turn` spreads `budget.totals()` into the top-level
   `cost` payload (`gateway/metering.py`), and `BudgetState.record_usage` accumulates with
   `+=` (`budget/state.py`). The per-turn delta is isolated under the separate `turn` key.
   Quota aggregation's assumption holds; replay stays idempotent, no `INCRBY` switch needed.
2. **~~Decide the isolation provider.~~ DECIDED 2026-09-15 — self-hosted K8s + gVisor.**
   Ratifies what the deep design docs already build on (`orchestration.md §3`,
   `conductor.md`, `provisioner.md`): Namespace-per-engagement, gVisor `RuntimeClass`,
   Cilium `NetworkPolicy`, Kaniko in-cluster build. Managed microVM (Fly / E2B) was the
   alternative but is rejected — `orchestration.md §3.1` already ruled out microVMs as
   overkill. Step-3 isolation hardening is unblocked.
3. **~~Set the red-team cadence (H-Q1).~~ DECIDED 2026-09-15 — full GKE pass is a
   release gate.** The full §7 red-team pass runs on real GKE per release/tag (the H3
   exit-gate run); the reduced kind pass plus `hardening.spec.ts` stays the per-merge
   continuous guard. Aligns with §8.4 (GKE deploy already tag/main-gated) and §13
   ("continuously guarded, not one-time"); lowest GKE cost/time that still gates releases.

### Can wait

- Admin / operator UI — the `429` snapshot and read-only dashboards suffice for now.
- Streaming read-path split — only when connection scaling demands it.
- Harness `traceparent` emission (H-Q2) — accepted degradation; `engagement_id`
  correlation already holds.
- Concurrency-cap race (Q2) — soft-cap correctness nicety, not a security seam.
- Windowed caps (Q3) and multi-instance aggregator (Q4) — need the billing model and
  horizontal scale respectively.
- Image supply-chain hardening — SBOM / cosign / provenance (H-Q5), additive.
- Buildpack fallback — leaning deferred permanently.
- Post-exploit thinness — accept the single-container limit for now.

---

## What's next after the control plane

Per the overview §6 build order, the control plane is step 2 and is **done** (Components
0, A–H all built).

**Already built (release path / step-3 substrate — verified against the repo 2026-09-15):**
the H2 release artifacts and the decided red-team cadence are in the tree and committed,
not pending:
- `deploy/helm/control-plane/` — Helm chart (deployment, hpa, service, serviceaccount).
- `deploy/terraform/main.tf` — GKE Autopilot + Vault + registry.
- `scripts/redteam.sh` — the §7 red-team pass (SEAM-1 egress matrix, SEAM-2 secret split).
- `control-plane/test/hardening.spec.ts` — the H1 seam proofs in CI.
- `.github/workflows/release.yml` — build→scan→push→GHCR, `redteam-kind` reduced pass per
  push/tag, `deploy-gke` behind a `production` approval environment, then the full GKE
  red-team pass as the release gate. **This already implements the H-Q1 cadence decision.**

**Remaining milestones:**

1. **Step 3 — Isolation hardening = orchestration / conductor / provisioner Phase B.**
   This is the true next milestone and the real gap: the provisioner and conductor are
   **Phase A only — plain local Docker** (`provisioner/src/autosploit_provisioner/__init__.py`
   states Kubernetes / Kaniko / NetworkPolicy are Phase B; a code grep finds no gVisor /
   Kaniko / RuntimeClass / NetworkPolicy anywhere but doc comments). Phase B moves the
   engagement off `docker run -P` onto the cluster: Namespace-per-engagement, **Kaniko**
   in-cluster build, **gVisor** `RuntimeClass`, **Cilium** default-deny **NetworkPolicy**,
   conductor as a real `kubernetes` client. Isolation-provider decision settled (self-hosted
   K8s + gVisor, above); the release path and red-team script above are already in place.
2. **~~H3 exit gate — prove `redteam.sh` green.~~ DONE 2026-10-06.** Ran green against
   the real CiliumNetworkPolicy under live egress on the self-hosted Contabo VPS (kind,
   Cilium 1.21.0-pre.2) — SEAM-1 egress matrix + SEAM-2 secret split both enforced; two
   latent policy bugs fixed (NXDOMAIN model FQDN `api.openrouter.ai`→`openrouter.ai`; plane
   port 80→backend 3000 for Cilium `toEndpoints`). Self-hosted, not GKE (the decided
   provider). **Step 3 closed.** The full GKE §7 pass remains as a per-release cadence (H-Q1).
3. **Step 4 — Orchestration at scale.** Job controller, per-engagement teardown, and
   quota under real load. Turns the demo into a platform.

**Parallel major effort — the new engine architecture (overview §7).** The adaptive
attack loop (planner/executor split, tool-selection policy, memory model, termination
criteria) replacing the rigid-pipeline model. Needs its own design doc. The platform
guarantees stay fixed regardless (typed tool adapter, deterministic interceptor,
immutable scope allowlist, live event stream); only the engine interior changes.

Fastest real unlock: provisioner/conductor **Phase B** (Docker → K8s + gVisor) — the one
remaining piece of the step-3 story. Everything downstream (Helm chart, Terraform,
red-team script, release workflow, the H-Q1 cadence) is already built and waiting for a
real cluster; the Q1 confirm and isolation-provider decision are both settled above.

---

## Cross-cutting

- **Admin / operator surface.** Grafana dashboards over metrics + traces are in scope
  (Component H), but there is **no authenticated operator UI inside the plane** — no
  per-user meters, no engagement admin. Dashboards are read-only ops telemetry, not a
  control surface. The `429` snapshot is currently the only window into a user's totals.
  *(control-plane §11, component-h §14 H-Q4, component-q §14 Admin surface)*

- **Streaming read-path split.** The SSE gateway is the first slice likely to move out
  of the monolith if connection scaling demands it — designed as a clean read end of
  Component D to make that extraction cheap. Not yet done.
  *(control-plane §11)*

- **Build-context ingestion under default-deny egress (M8 × M7 → M5).** The M7
  egress matrix governs the whole engagement namespace, so the Kaniko build Pod can
  reach no external git host or base-image registry: an external `git clone` and any
  `FROM <external>` base pull are denied by design. The M8 live proof
  (`scripts/m8-proof.sh`) sidesteps this by feeding the build context from an
  in-cluster ConfigMap (`dir://`) with a base already resolvable, isolating the M8
  machinery from the egress interaction. Real user repos need an **in-cluster
  repo/base mirror** (the M5 registry path) that Kaniko clones and pulls from over an
  allowed intra-namespace edge — not a widening of the egress matrix. Until M5 lands,
  `--k8s` on an arbitrary external repo will fail the clone under the live policy.
  *(roadmap M8 "Open"; roadmap M5; orchestration.md §5)*

---

## Security / release (Component H)

- **H-Q1 — full red-team on GKE — DECIDED 2026-09-15: release gate.** The complete §7
  red-team pass needs a real GKE cluster with the orchestration NetworkPolicy; CI runs a
  reduced pass on kind. Cadence settled: the full GKE pass runs **per release/tag** (the
  H3 exit-gate run), with the CI kind pass plus `hardening.spec.ts` as the per-merge
  continuous guard. Matches §8.4 (GKE deploy is already tag/main-gated) and §13.

- **H-Q5 — image supply-chain hardening.** Trivy/scout scan + non-root + pinned base
  images are in scope. **SBOM generation, image signing (cosign), and provenance
  attestation are deferred** as the natural next step, additive to the release workflow.

---

## Observability / tracing

- **H-Q2 — harness-side `traceparent` emission (cross-repo).** Full trace propagation
  needs the harness to stamp the incoming `traceparent` onto emitted events (a small
  additive contract touch in `harness/contracts/`). Until then the distributed trace
  spans **dispatch → worker → conductor-spawn (TS side only)**; the Python interior of
  the conductor/harness is a single opaque span rather than fully nested. Accepted
  degradation — the `engagement_id` correlation across logs, metrics, and the TS trace
  holds regardless.

---

## Quota (Component Q)

- **Q1 — `cost` event semantics — CONFIRMED CUMULATIVE (2026-09-15).** Aggregation assumes
  `cost.data` is a **cumulative running total**, which makes replay idempotent. Confirmed
  against the harness source: `meter_turn` emits `{**budget.totals(), "turn": {...}}`
  (`harness/src/autosploit_harness/gateway/metering.py`), and `BudgetState` accumulates the
  top-level `tokens`/`usd`/`tool_calls` with `+=` (`budget/state.py`); the per-turn delta
  lives only under the separate `turn` sub-key. No `INCRBY` switch or offset-tied writes
  needed; the assumption stands.

- **Q2 / H-Q3 — concurrency-cap race.** The concurrency check reads `countActive` with a
  tiny check-then-act window. A race-free upgrade needs an atomic Redis reservation with
  a terminal-state release, which needs an engagement-state signal — deliberately kept
  off the topic (§5 rule 3). Deferred; H declined to add it (correctness nicety on a
  *soft* cap, not a security seam; the C→Q terminal hook would touch C's write path). The
  money-relevant **spend** cap is unaffected.

- **Q3 — window / reset.** Caps are **lifetime** totals in this build. Billing-period
  windows (monthly reset) need a keyed-by-window meter
  (`quota:usd:user:<id>:<yyyy-mm>`) plus a roll-over purge of the per-engagement hashes
  and findings set. Additive to the key contract, deferred.

- **Q4 — multi-instance aggregator.** Single aggregator instance is the P6 assumption.
  The Lua compare-and-add upgrade is the path to horizontal scale, deferred alongside the
  streaming read-path split.

---

## Product / architecture (overview)

- **Buildpack fallback (§2.1 step 3).** Buildpacks / Nixpacks language auto-detect is
  deferred. MVP ships the compose + Dockerfile ladder only ("target must be
  containerized"). Leaning deferred permanently.

- **Post-exploit thinness (§2.2).** A fresh single-container deploy is thin ground for
  infra/network/lateral-movement. Open: accept the single-container limit, or require
  multi-service compose to keep lateral movement meaningful. Multi-service compose
  targets are an additive scope change owned by the provisioner; the engagement model
  already keys everything by `engagement_id`, so the control plane is unaffected.

- **Isolation provider — DECIDED 2026-09-15: self-hosted K8s + gVisor.** Chosen over the
  managed microVM alternative (Fly Machines / E2B) for the deeper infra story and to match
  the isolation model the design docs already build on (`orchestration.md §3` / §3.1,
  `conductor.md`, `provisioner.md`). "I operate the cluster myself" over "shipped and safe."

- **Cost / billing model.** Per-run compute + egress + model spend → per-user quota,
  reusing the budget-metering primitive as the billing basis. Not yet built.

- **New engine architecture (§7).** The shape of the adaptive attack loop —
  planner/executor split, tool-selection policy, memory model, termination criteria —
  is the next major design effort and is specified separately from the current docs.

---

## Operational debt (not in design docs)

- **Leaked OpenRouter keys — RESOLVED 2026-09-15.** Both keys were rotated/revoked at
  openrouter.ai. The old value still sitting in origin history is now a dead key — the
  leak is harmless (history was left intact by choice). `.env` remains untracked to
  prevent recurrence.
