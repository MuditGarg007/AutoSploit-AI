"""report — ledger → engagement report (docs/harness.md §5, §8).

Reads the on-disk ledger (findings + attempt log + tool outputs) and renders the
final report. Two exit paths, both produce a report:
  - engagement_complete (agent-driven) → full report (carries the agent summary).
  - budget/scope halt (interceptor-driven) → partial report.

For eval runs this feeds scoring (eval/score.py): found/exploited, cost, step
count, false positives. Reads the same artifacts the dashboard would — no
separate reporting path.

Step 2 (§9): findings + attempt count come from the on-disk ledger; turns and
tool-result counts from the transcript; budget totals from BudgetState.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.ledger.store import Ledger


@dataclass(frozen=True, slots=True)
class Report:
    """Engagement report — the shape driver.run returns."""

    completed: bool  # False → partial (interceptor halt)
    halt_reason: str | None
    summary: str | None  # agent's engagement_complete summary, if any
    turns: int  # agent LLM turns
    tool_results: int  # tool executions that came back
    findings: list[dict[str, Any]]  # the scored artifact, from the ledger
    attempts: int  # attempted tool calls recorded in the ledger
    budget: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "completed": self.completed,
            "halt_reason": self.halt_reason,
            "summary": self.summary,
            "turns": self.turns,
            "tool_results": self.tool_results,
            "findings": self.findings,
            "attempts": self.attempts,
            "budget": self.budget,
        }


def build_report(final_state: dict, budget: BudgetState, ledger: Ledger) -> Report:
    """Assemble the report from the final graph state + the on-disk ledger."""
    messages = final_state.get("messages", [])
    halt = final_state.get("halt")
    turns = sum(1 for m in messages if isinstance(m, AIMessage))
    tool_results = sum(1 for m in messages if isinstance(m, ToolMessage))
    return Report(
        completed=halt is None,
        halt_reason=halt,
        summary=final_state.get("completed_summary"),
        turns=turns,
        tool_results=tool_results,
        findings=ledger.findings(),
        attempts=len(ledger.attempts.all()),
        budget=budget.totals(),
    )
