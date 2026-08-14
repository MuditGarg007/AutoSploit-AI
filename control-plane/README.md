# Autosploit — Control Plane

Trusted API that wraps the attack engine (`harness/`), provisioner, and conductor
with auth, persistence, a job queue, and a live event fan-out. Full design:
[`../docs/control-plane.md`](../docs/control-plane.md). Roadmap + exit gates: §12.

**Trusted code that never touches untrusted input** — holds the GitHub token vault
and mints per-engagement credentials, but repo bytes and the model key never enter
it. One inbound edge from a sandbox: events pushed *up* (ingest). Never reaches *down*.

## Stack

Bun (package manager + workspaces) · **Node 22 runtime** · NestJS (Fastify) · Drizzle
+ Postgres · BullMQ (Redis) · Redpanda (Kafka API) + Schema Registry · Redis Streams
(SSE last-mile) · Vault Transit (token vault) · S3/MinIO. Bun is the package manager
only; the runtime stays Node 22 (§9.1).

## Layout — one folder per bounded context (§4)

Each domain is one bounded context (the design's "vertical slice"): owns its own
tables, has a **single writer**, exposes one client capability, ships as its own
Nest module + schema.

```
src/
  main.ts                 Fastify bootstrap (native SSE)
  app.module.ts           wires the five domains + cross-cutting modules
  config/                 typed env (no OPENROUTER_API_KEY — secret split, §6)
  db/
    drizzle.module.ts     one pool + Drizzle handle, injected everywhere
    schema/index.ts       barrel re-exporting every domain-owned schema
    migrations/           drizzle-kit output
  core/                   cross-cutting — NOT domains
    health/               GET /health (P0 gate)
    guards/               auth boundary (session, ownership)
    interceptors/         quota + telemetry (quota is middleware, not a domain, §5)
  trpc/                   type-safe command router (SSE excluded)
  domains/
    identity/             A · users, sessions, github_tokens  → vault/
    repos/                B · repo_cache (deployable probe)
    lifecycle/            C · engagements (SOLE writer of state) → state-machine/, worker/
    telemetry/            D · findings, cost + Kafka log  → ingest/, sse/, consumers/
    reports/              E · reports + object-store refs
```

### Domain → table ownership (§4, §5 one-writer-per-table)

| Domain | Owns | Sole writer of |
|-------|------|----------------|
| A · Identity | `users`, `sessions`, `github_tokens` | user records + token vault |
| B · Repos | `repo_cache` | cache only |
| C · Lifecycle | `engagements` (+ state machine, §7) | **engagement state** |
| D · Telemetry | `findings`, `cost` (projections of the Kafka log) | events / findings / cost |
| E · Reports | `reports` | report artifacts |

Cross-domain coupling is only the three seams in §8: C mints / D validates the ingest
token; C shells the conductor; E reads D. No domain reads another's tables.

## Dev

```sh
# From the repo root (Bun workspaces + Turborepo, docs/control-plane.md §9.1)
bun install
bun run build     # turbo — @autosploit/contracts (tsc) then control-plane (nest build)
bun run test      # drift spec + migrations + health on real Postgres (Testcontainers)
bun run lint
bun run typecheck
```

Control-plane standalone:

```sh
cd control-plane
cp .env.example .env      # fill in secrets; NEVER commit .env
bun run db:generate       # generate SQL migrations from schema
bun run db:migrate        # apply
bun run start:dev
```

### Shared event types (`@autosploit/contracts`, §8.1 border)

The event contract types are **generated** from the frozen harness schema
(`harness/contracts/contract.schema.json`), never hand-mirrored. Regenerate when the
Python side bumps the contract:

```sh
cd packages/contracts
bun run generate
```

`packages/contracts/test/drift.spec.ts` fails the build if the committed types drift
from the schema — the TS mirror of the harness's own `tests/test_contracts.py` gate
(`harness.md §9` step 5). The first real consumer lands in P4 (ingest).

Build order is the P0→P6 roadmap in [`../docs/control-plane.md`](../docs/control-plane.md) §12.
Current state: **P0 scaffold complete** — workspace + Turborepo, generated contract
types, first migration (8 tables), `GET /health` with a live DB check, all green in
CI against real Postgres (Testcontainers). Domain bodies are `TODO(Pn)` stubs keyed
to their milestone.
