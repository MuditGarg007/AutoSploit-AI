"""run — the top-level engagement loop (docs/harness.md §1, §9 step 1).

Wires the slices into a run:
  1. load config + scope (driver/config.py) → freeze scope (§3).
  2. build the model (gateway/) and the LangGraph graph (agent/graph.py).
  3. open the ledger (ledger/) and event emitter (events/).
  4. invoke the graph; every tool call crosses the interceptor node (§2, §3).
  5. on engagement_complete OR budget/scope halt → build the report (driver/report.py).

Owns no domain logic — it composes slices. The public run signature is a §9
seam; keep it stable so provisioner + control plane plug in unchanged.

Step 2 (§9): the on-disk ledger opens in the run directory and threads through
the graph + report; findings/attempts read from disk.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.messages import HumanMessage

from autosploit_harness.agent.graph import build_graph
from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.contracts.version import CONTRACT_VERSION
from autosploit_harness.driver.config import RunConfig, load_config, load_scope
from autosploit_harness.driver.report import Report, build_report
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.ledger.store import Ledger

# Recursion cap so a runaway loop can't spin forever even before budget bites.
# Each agent→interceptor→tools cycle is ~3 super-steps. Keep this well ABOVE
# (max_tool_calls × 3) so the budget cap is the clean terminator (partial report)
# and this stays a last-resort backstop, not the normal stop.
GRAPH_RECURSION_LIMIT = 200

DEFAULT_OBJECTIVE = (
    "Begin the engagement. Recon the target in scope, identify vulnerabilities, "
    "and exploit what you can. Report what you find."
)


def run_engagement(
    *,
    model,
    scope: ScopeAllowlist,
    budget: BudgetState,
    emitter: JsonlEmitter,
    ledger: Ledger,
    objective: str = DEFAULT_OBJECTIVE,
) -> tuple[Report, dict]:
    """Build and drive the graph with already-constructed slices.

    The injectable core — the smoke test calls this with a fake model and a
    tmp-dir ledger. Returns (report, final_state).
    """
    graph = build_graph(model=model, budget=budget, emitter=emitter, scope=scope, ledger=ledger)
    emitter.emit("phase", {"stage": "start", "host": scope.host, "ports": list(scope.ports)})

    initial_state = {
        "messages": [HumanMessage(content=objective)],
        "scope": scope,
        "budget": budget,
        "ledger": ledger,
        "phase": "start",
        "halt": None,
        "approved": [],
        "completed_summary": None,
        "nudges": 0,
    }
    final_state = graph.invoke(initial_state, config={"recursion_limit": GRAPH_RECURSION_LIMIT})

    report = build_report(final_state, budget, ledger)
    emitter.emit("halt" if not report.completed else "phase",
                 {"stage": "end", **report.to_dict()})
    return report, final_state


def run(config_path: Path) -> Report:
    """Full run from a config file: load → build model → drive → report to disk.

    This is the seam the CLI and (later) the control plane invoke (§9).
    """
    from autosploit_harness.gateway.client import build_model  # deferred: needs API key

    cfg: RunConfig = load_config(config_path)
    scope = load_scope(cfg.scope_file)

    run_dir = cfg.output_dir / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir.mkdir(parents=True, exist_ok=True)

    # Stamp the contract version into the run so any consumer (dashboard, TS
    # control plane) can assert it speaks the same seam shape before reading the
    # events/report (§9 step 5).
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "contract_version": CONTRACT_VERSION,
                "model_id": cfg.model_id,
                "scope_file": str(cfg.scope_file),
                "started": run_dir.name,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    budget = BudgetState(
        max_tokens=cfg.max_tokens,
        max_usd=cfg.max_usd,
        max_tool_calls=cfg.max_tool_calls,
    )
    model = build_model(
        cfg.model_id, reasoning=cfg.reasoning, fallbacks=cfg.fallbacks
    )
    ledger = Ledger(run_dir)

    with JsonlEmitter(path=run_dir / "events.jsonl") as emitter:
        report, _ = run_engagement(
            model=model, scope=scope, budget=budget, emitter=emitter, ledger=ledger
        )

    (run_dir / "report.json").write_text(
        json.dumps(report.to_dict(), indent=2), encoding="utf-8"
    )
    return report
