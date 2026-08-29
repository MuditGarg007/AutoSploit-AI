# autosploit-harness

The attack engine — the LangGraph agent loop that runs inside the attacker
sandbox. Full design: [`../docs/harness.md`](../docs/harness.md).

Built **standalone first**: one machine, one local vulnerable target (OWASP Juice
Shop), no auth / queue / microVM / control plane. If the agent can't exploit a
known-vuln box here, nothing else in the platform matters.

## Layout — vertical slices

Each `src/autosploit_harness/` subpackage owns one box from the design (§1). Slices
touch each other only through the frozen shapes in `contracts/` (the seams the TS
control plane plugs into later, §9).

| Slice | Owns | Doc |
|-------|------|-----|
| `contracts/` | frozen seams: event schema, scope shape, state, results | §2,§4,§7,§9 |
| `driver/` | config in → build graph → run → report (also the eval harness) | §1,§8 |
| `agent/` | LangGraph topology + the agent's LLM turn | §2 |
| `interceptor/` | the deterministic gate: budget + scope, fail-closed, no LLM | §3 |
| `tools/` | typed adapters (run_shell, http_request, note_finding, ...) | §4 |
| `gateway/` | OpenRouter provider isolation + cost metering | §6 |
| `budget/` | shared caps: gateway measures, interceptor enforces | §6.2 |
| `ledger/` | on-disk findings + attempt log + tool outputs + context mgmt | §5 |
| `events/` | JSONL emitter (SSE later, same schema) | §7 |
| `eval/` | scoring rig — consumes the driver, ships outside the package | §8 |

## Toolchain — uv (not venv)

```bash
uv sync              # create .venv + install from uv.lock
uv run pytest        # tests
uv run autosploit-harness run --config configs/run.example.toml
uv add <pkg>         # add a dependency (writes uv.lock)
```

## Status

Scaffold only — every module is a docstring describing its scope/purpose. Build
order in §9: (1) skeleton loop → (2) full tool surface → (3) gateway hardening →
(4) eval rig → (5) freeze seams.
