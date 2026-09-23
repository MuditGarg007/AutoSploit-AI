# Autosploit — Cloud Automated Pentesting Platform

> **Status: planning / pre-build (2026-08-08).** This document is the design record
> for the project. It describes the product, the core architectural decisions already
> made, and the open questions to resolve while building. The attack engine's internal
> agent workflow is described only at a high level here — that piece is getting a new,
> more flexible architecture (see §7) and will be specified separately.

---

## 1. What it is

Autosploit is a **cloud web app that runs an automated penetration test against a
user's application**. A user logs in, connects GitHub, picks a repo. The platform
deploys that repo into an isolated, sandboxed environment, points an autonomous
attack engine at the live instance, and streams the whole engagement — agent
activity, tool calls, findings, cost — to a live dashboard, ending in a report.

It is both a real product and a portfolio-grade full-stack + security engineering
project: a **client**, an **API / control plane**, a **sandbox provisioning layer**
that stands up isolated targets and attackers, and **orchestration** to run many
engagements safely.

---

## 2. The load-bearing decision: deploy-then-attack

The single decision that shapes everything else.

An automated pentest engine attacks a **running target** — hosts, services, ports.
A GitHub repo is **static source code**; an attack loop has nothing to point at.
Two ways to reconcile them, and they are genuinely different products:

- **Deploy-then-attack (DAST) — chosen.** Stand the repo up as a running app, then
  attack the live instance. Keeps the entire attack engine useful.
- **Static analysis (SAST) — rejected.** Point semgrep/codeql/trivy at the code.
  This throws away the dynamic attack engine entirely — a different tool.

**Why deploy also solves authorization.** You may only attack targets the user is
authorized for. Verifying a user owns some arbitrary URL is hard and spoofable (DNS
tokens, `.well-known` files, meta tags — all friction, all legal exposure). Deploy
sidesteps it: GitHub OAuth → user selects a repo **they have access to** → the
platform deploys it to **its own** ephemeral environment → the engine attacks a
target the platform itself created. **Ownership is automatic because you spun the
target up.** Scope is the container you control.

### 2.1 Don't build a PaaS — delegate the build

No language detection or build orchestration is written in-house. A fallback ladder
delegates to off-the-shelf tooling:

1. `docker-compose.yml` present → `compose up`. Best case — real apps ship a DB/cache,
   which is what makes them exploitable (app + db + cache).
2. `Dockerfile` present → `docker build` + `run`.
3. *(deferred)* Buildpacks / Nixpacks (`pack build`) → auto-detect language, produce
   an image. This is the "language detection" piece — off-the-shelf, never hand-built.
4. None → reject with a clear message.

**MVP ships steps 1–2 only.** "Target must be containerized" is a defensible
constraint. The platform orchestrates Docker; it never writes build logic.

### 2.2 Known limit of a fresh deploy

A freshly deployed repo is empty and single-instance — no prod data, no real users,
no misconfigured infra. Still exploitable: app-layer vulns (auth bypass, injection,
IDOR, SSRF) and exposed services from compose (unauth'd DB, admin panels). **Thin
ground:** infra/network/lateral-movement — little to pivot to in one container.
Multi-service compose restores some of it. A limitation to flag, not a blocker.

---

## 3. Architecture — four planes

```
CLIENT (browser)        GitHub login · repo picker · live dashboard · report viewer
      │  HTTPS ↓                                       ↑ SSE/WS live event stream
API · CONTROL PLANE     auth · engagement svc · job dispatcher · streaming gateway
   (stateless + stores) Postgres · Redis queue · object store
      │  dequeue ↓
ORCHESTRATION           job controller — provisions one sandbox per engagement
      │  provision ↓ (stream events ↑)
┌─ PER-ENGAGEMENT SANDBOX ── egress default-deny · ephemeral ──────────────────┐
│  ATTACKER SANDBOX (attack engine)        TARGET SANDBOX (deployed repo)       │
│  ▸ autonomous agent loop                 ▸ docker compose up / Dockerfile     │
│  ▸ tool-call interceptor (scope/budget)  ▸ app + db + cache                   │
│  ▸ typed tool adapters                ─► ▸ exposed ports discovered           │
│  ▸ on-disk memory + ledger               ▸ auto-generated scope allowlist     │
│  ▸ model gateway (allowlisted egress)                                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

**1 · Client** — GitHub OAuth (login + consent record); repo picker (flags deployable
repos); **live dashboard** (agent activity, tool-call feed, findings table, phase
state, cost meter — the demo that sells the project); report viewer.

**2 · Control plane** — auth service (OAuth/JWT, per-user scoping); engagement service
(CRUD, findings metadata, run history); job dispatcher (validate + enqueue, enforce
per-user quota); streaming gateway (fan sandbox events to the right client);
**Postgres** (multi-tenant system of record); **Redis** durable job queue; **object
store** (memory bundles, raw logs, rendered reports).

**3 · Orchestration** — job controller (consume queue, provision one sandbox per
engagement, tear down); isolation runtime (the real security boundary, §5); network
policy (default-deny egress).

**4 · Target provisioner** — read-only repo cloner (user token, sandbox-only, never
logged); build resolver (§2.1 ladder); health + port discovery; scope allowlist
generator (auto-emits the immutable target IP + ports before the engine starts).

---

## 4. Security model — non-negotiable

The platform runs offensive tools and executes attacker-influenced code in its own
cloud account. Three realities drive the design:

- **Real isolation, not plain Docker.** Plain Docker is not a security boundary
  against hostile in-container code — an escape reaches the cluster. Requires
  **gVisor, Kata, or Firecracker microVMs**.
- **Locked egress.** An uncontrolled pentest box is an open SSRF/abuse proxy pointed
  at the internet from your account — the provider suspends you. Default-deny;
  allowlist only the target + model API.
- **Enforced scope + logged consent.** Attack only what the user authorized; the
  auto-generated immutable scope allowlist is the control, enforced server-side.

### 4.1 Egress matrix — exactly two edges leave the sandbox

| From     | To            | Rule                         |
|----------|---------------|------------------------------|
| Attacker | Target        | **ALLOW** (the pentest)      |
| Attacker | Model API     | **ALLOW** (allowlisted host) |
| Sandbox  | Control plane | **ALLOW** (events only)      |
| Attacker | Open internet | **DENY**                     |
| Target   | Open internet | **DENY**                     |

Kill the internet edges and an in-container escape has nowhere to pivot; kill the
model edge and a run halts safely rather than reaching out.

---

## 5. One engagement, end to end

1. **Login** — GitHub OAuth; token grants repo read, records consent.
2. **Select repo** — picker shows deployable repos; user confirms authorization.
3. **Enqueue** — dispatcher checks quota, writes engagement to Postgres, pushes to Redis.
4. **Provision** — controller spins an isolated sandbox (microVM, default-deny net).
5. **Deploy target** — clone, resolve build (compose → Dockerfile), boot, discover
   ports, write the immutable scope allowlist.
6. **Attack** — engine starts, reads scope, runs the agent loop against the target.
7. **Every tool call** crosses the scope/budget interceptor — no path skips it.
8. **Stream up** — each phase/tool/finding/cost event → gateway → live dashboard.
9. **Persist** — findings index to Postgres; memory bundle + logs to object store.
10. **Finish or halt** — completion → full report; budget/scope halt → partial report.
11. **Teardown** — controller destroys both sandboxes. Nothing offensive outlives the run.

---

## 6. Build order — prove the loop, then make it safe, then make it scale

Isolation and orchestration are the **last** mile, not the first.

1. **Vertical slice** — one hardcoded repo, single machine, no auth, no queue.
   Deploy + attack + stream events. Prove the deploy-then-attack loop works end to
   end. This is where the core idea either resolves or dies — find out first.
2. **Control plane** — wrap with auth, Postgres, engagement CRUD, Redis queue.
3. **Isolation hardening** — microVM/gVisor, default-deny egress. Makes it safe to
   run untrusted repos.
4. **Orchestration at scale** — job controller, per-engagement teardown, quotas.
   Turns a demo into a platform.

Building isolation/scale before the core loop is proven burns time on the wrong risk.

---

## 7. The attack engine — deliberately left flexible

The engine that drives the actual pentest inside the attacker sandbox is **not yet
fixed** and is intentionally under-specified here. The prior mental model of a
**rigid pipeline with a fixed set of phases and a fixed number of steps** is being
replaced with a **more flexible, adaptive architecture** — one that decides what to
do next based on what it has found, rather than marching through predetermined stages.

What is fixed regardless of the engine's internal shape (these are platform-level
guarantees, not engine details):

- **Every subprocess goes through a typed tool adapter** — the only path to running a
  tool. No ad-hoc shell escapes.
- **Every tool call crosses a deterministic interceptor** that enforces scope and
  budget before execution — no LLM in that decision, fail-closed.
- **The scope allowlist is immutable for the run's duration** — written by the
  provisioner before the engine starts, never modified mid-run.
- **The engine emits a live event stream** (phase/tool/finding/cost) to the control
  plane — the one seam the dashboard depends on.

The engine's decision-making, memory shape, and how it structures work will be
specified in a separate design doc once the new architecture is settled.

---

## 8. Open questions

- **Buildpack fallback (§2.1 step 3):** MVP or deferred? (Leaning deferred.)
- **Post-exploit thinness (§2.2):** accept the single-container limit, or require
  multi-service compose to keep lateral-movement meaningful?
- **Isolation provider — DECIDED 2026-09-15: self-hosted K8s + gVisor** (over the managed
  microVM alternative, Fly Machines / E2B). Matches the isolation model the orchestration /
  conductor / provisioner docs already build on; unblocks step-3 hardening. See
  `deferred-open-items.md` for the record.
- **Cost model:** per-run compute + egress + model spend → per-user quota, reusing the
  budget-metering primitive as the billing basis.
- **New engine architecture (§7):** the shape of the adaptive loop — planner/executor
  split, tool-selection policy, memory model, termination criteria — is the next major
  design effort.
