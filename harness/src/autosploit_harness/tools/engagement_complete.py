"""engagement_complete — agent-driven termination (docs/harness.md §4, §5).

    engagement_complete(summary) -> CompleteResult

The agent signals it's done → the graph routes this straight to a terminal node
→ END → driver builds the full report (§5). One of two termination paths; the
other is an interceptor budget/scope halt, which yields a partial report.

Unlike the other tools, this is not executed by the tool node: route_after_agent
detects the call and sends the graph to the `complete` node (agent/nodes.py),
which reads the summary and ends the run. This module defines the return shape
and the tool's schema-facing signature (registry binds it for the model).
"""

from __future__ import annotations

from autosploit_harness.contracts.results import CompleteResult


def engagement_complete(summary: str) -> CompleteResult:
    """Return the agent's done signal. Terminal — routed to END, not executed
    through the tool node (see agent/nodes.complete_node)."""
    return CompleteResult(summary=summary)
