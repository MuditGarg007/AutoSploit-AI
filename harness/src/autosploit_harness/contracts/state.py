"""EngagementState — the LangGraph StateGraph schema (docs/harness.md §2).

The TypedDict that flows through the graph:
    messages  Annotated[list, add_messages]  conversation transcript
    scope     ScopeAllowlist                  immutable for the run (§3)
    ledger    Ledger handle                   findings + attempt log, on disk (§5)
    budget    BudgetState                     tokens + tool-call counters (§6.2)
    phase     str                             emitted, not enforced — adaptive (§7)

Shape only. The nodes that read/write this state live in agent/, interceptor/,
tools/. Kept in contracts/ because every node slice depends on its shape.

Step 2 (§9) adds `ledger` (on-disk findings + attempt log), `approved` (the
tool calls the interceptor cleared for the tool node), and `completed_summary`
(set by the complete node on engagement_complete).
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from langgraph.graph.message import add_messages

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.ledger.store import Ledger


class EngagementState(TypedDict):
    """State flowing through the graph. `budget` + `ledger` are shared handles."""

    messages: Annotated[list, add_messages]
    scope: ScopeAllowlist
    budget: BudgetState
    ledger: Ledger
    phase: str
    # Set by the interceptor when a cap is crossed; routes the graph to END for a
    # partial report. Carries the halt reason for the halt event / report.
    halt: str | None
    # The tool calls the interceptor cleared this turn — the tool node executes
    # exactly these (denied calls get an error tool_result from the gate instead,
    # never a subprocess). Rewritten every interceptor pass.
    approved: list[dict]
    # Set by the complete node when the agent calls engagement_complete; carries
    # the agent's closing summary into the full report.
    completed_summary: str | None
    # Count of prose-instead-of-tool nudges spent this run (§6.1.2). The recover
    # node bumps it; past the cap a bare-prose turn ends the run instead of looping.
    nudges: int
