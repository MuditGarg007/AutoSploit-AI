"""graph — StateGraph wiring (docs/harness.md §2).

Builds the topology:

    agent ──engagement_complete?──▶ complete ──▶ END
      ▲   ──other tool_use?──▶ interceptor ──halt──▶ END
      │        │                    │
      │        │              ┌─approved?─┐
      │        │            yes           no
      │        │             │             │
      │        │           tools           │  (all denied → adapt)
      │        └── no tool ──▶ END          │
      └──────────────┴───────────────────────┘

Deliberately NOT LangGraph's prebuilt ToolNode — that executes tools with no
gate. The interceptor node sits in front and partitions the turn's calls: it
forwards approved calls to the tool node and short-circuits denied ones with a
tool_result carrying is_error=true, routing back to the agent so it can adapt —
a denied call never touches a subprocess (§2, §3).

Step 2 (§9): the full tool surface. The interceptor screens schema + scope +
repeat; engagement_complete routes to the complete node → END → full report; a
budget halt routes to END → partial report.
"""

from __future__ import annotations

from functools import partial

from langgraph.graph import END, START, StateGraph

from autosploit_harness.agent.nodes import (
    agent_node,
    complete_node,
    recover_node,
    route_after_agent,
    route_after_recover,
    tool_node,
)
from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.contracts.state import EngagementState
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.interceptor.gate import (
    interceptor_node,
    route_after_interceptor,
)
from autosploit_harness.ledger.store import Ledger
from autosploit_harness.tools import registry


def build_graph(
    *,
    model,
    budget: BudgetState,
    emitter: JsonlEmitter,
    scope: ScopeAllowlist,
    ledger: Ledger,
):
    """Wire the full-surface loop and compile it.

    Deps are injected (not imported by nodes) so the same topology runs a live
    engagement or a fake-model smoke test. `model` is already tool-bound by the
    gateway (§6); `callables` carry the ledger + emitter the typed tools need.
    """
    callables = registry.build_callables(ledger, emitter)

    graph = StateGraph(EngagementState)

    graph.add_node(
        "agent", partial(agent_node, model=model, budget=budget, emitter=emitter)
    )
    graph.add_node(
        "interceptor",
        partial(interceptor_node, budget=budget, emitter=emitter, scope=scope, ledger=ledger),
    )
    graph.add_node(
        "tools",
        partial(tool_node, emitter=emitter, callables=callables, ledger=ledger),
    )
    graph.add_node("recover", partial(recover_node, emitter=emitter))
    graph.add_node("complete", partial(complete_node, emitter=emitter))

    graph.add_edge(START, "agent")
    graph.add_conditional_edges(
        "agent",
        route_after_agent,
        {
            "interceptor": "interceptor",
            "complete": "complete",
            "recover": "recover",
            "end": END,
        },
    )
    graph.add_conditional_edges(
        "interceptor",
        route_after_interceptor,
        {"tools": "tools", "agent": "agent", "halt": END},
    )
    graph.add_conditional_edges(
        "recover",
        route_after_recover,
        {"agent": "agent", "end": END},
    )
    graph.add_edge("tools", "agent")
    graph.add_edge("complete", END)

    return graph.compile()
