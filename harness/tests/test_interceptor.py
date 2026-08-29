"""Interceptor tests (docs/harness.md §3) — the load-bearing gate, tested first.

Covers the fail-closed invariant above all else:
  - any error (malformed call, parse failure, missing scope field) → DENY.
  - budget over cap → HALT the run (partial report), not just block the call.
  - denied call returns a tool_result(is_error) to the agent, touches no subprocess.
  - never default-allow, no matter the input.

Step 2 (§9): the gate screens schema + scope + repeat per call (deny → corrective
tool_result, run continues) on top of the whole-run budget halt.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, ToolMessage

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.interceptor.gate import (
    interceptor_node,
    route_after_interceptor,
)
from autosploit_harness.ledger.store import Ledger

SCOPE = ScopeAllowlist(host="127.0.0.1", ports=(3000,))


def _state(budget: BudgetState, *, call: dict | None = None) -> dict:
    call = call or {"name": "run_shell", "args": {"cmd": "echo x", "timeout": 5}, "id": "c1"}
    msg = AIMessage(content="", tool_calls=[call])
    return {"messages": [msg], "scope": SCOPE, "budget": budget, "phase": "x", "halt": None}


def test_over_cap_halts_not_blocks(tmp_path):
    """Budget already at cap → HALT the run (partial), route to END."""
    budget = BudgetState(max_tool_calls=1)
    budget.record_tool_call(1)  # already at the cap
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)

    out = interceptor_node(_state(budget), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out["halt"] is not None
    assert "tool-call cap" in out["halt"]
    assert route_after_interceptor(out) == "halt"
    assert any(e["type"] == "halt" and e["data"]["cause"] == "budget" for e in emitter.events)


def test_under_cap_allows_and_counts(tmp_path):
    """Under cap → allow (route to tools), count the call, emit tool_call + cost."""
    budget = BudgetState(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)

    out = interceptor_node(_state(budget), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out.get("halt") is None
    assert out["approved"] and out["approved"][0]["name"] == "run_shell"
    assert route_after_interceptor(out) == "tools"
    assert budget.tool_calls == 1
    types = [e["type"] for e in emitter.events]
    assert "tool_call" in types and "cost" in types


def test_fail_closed_on_internal_error(tmp_path):
    """Any exception inside the gate → DENY (halt), never default-allow."""
    class Boom(BudgetState):
        def over_cap(self):  # force an error mid-gate
            raise RuntimeError("boom")

    budget = Boom(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)

    out = interceptor_node(_state(budget), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out["halt"] is not None  # denied, not allowed
    assert route_after_interceptor(out) == "halt"


def test_out_of_scope_http_denied(tmp_path):
    """http_request to an out-of-scope host → per-call deny, run continues."""
    budget = BudgetState(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)
    call = {"name": "http_request", "args": {"method": "GET", "url": "http://evil.example/"}, "id": "h1"}

    out = interceptor_node(_state(budget, call=call), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out.get("halt") is None
    assert out["approved"] == []  # not forwarded to the tool node
    assert budget.tool_calls == 0  # denied calls are not counted
    assert route_after_interceptor(out) == "agent"  # back to the agent to adapt
    denied = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert denied and "out of scope" in denied[0].content
    assert any(e["type"] == "tool_result" and e["data"]["is_error"] for e in emitter.events)


def test_in_scope_http_allowed(tmp_path):
    """http_request to the in-scope target → approved."""
    budget = BudgetState(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)
    call = {"name": "http_request", "args": {"method": "GET", "url": "http://127.0.0.1:3000/rest/products"}, "id": "h2"}

    out = interceptor_node(_state(budget, call=call), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out["approved"] and out["approved"][0]["id"] == "h2"
    assert route_after_interceptor(out) == "tools"


def test_malformed_call_denied_fail_closed(tmp_path):
    """Schema violation (http_request with no url) → deny, never execute (§6.1.1)."""
    budget = BudgetState(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)
    call = {"name": "http_request", "args": {"method": "GET"}, "id": "bad"}

    out = interceptor_node(_state(budget, call=call), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out["approved"] == []
    denied = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert denied and "invalid arguments" in denied[0].content


def test_invalid_tool_call_recovered(tmp_path):
    """A call LangChain couldn't parse (invalid_tool_calls) → corrective
    tool_result, never executed (§6.1.1). Malformed-call recovery."""
    budget = BudgetState(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)
    msg = AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {"name": "http_request", "args": "{bad json", "id": "iv1", "error": "invalid JSON"}
        ],
    )
    state = {"messages": [msg], "scope": SCOPE, "budget": budget, "phase": "x", "halt": None}

    out = interceptor_node(state, budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out["approved"] == []
    assert budget.tool_calls == 0  # a malformed call is never counted or executed
    assert route_after_interceptor(out) == "agent"  # back to the agent to reissue
    denied = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert denied and "malformed call" in denied[0].content
    assert denied[0].tool_call_id == "iv1"


def test_repeat_call_denied(tmp_path):
    """An identical call already in the attempt log → deny (§6.1.3)."""
    budget = BudgetState(max_tool_calls=10)
    emitter = JsonlEmitter(path=None, stdout=False)
    ledger = Ledger(tmp_path)
    args = {"cmd": "echo x", "timeout": 5}
    ledger.attempts.record("run_shell", args, result="prior")

    out = interceptor_node(_state(budget), budget=budget, emitter=emitter, scope=SCOPE, ledger=ledger)

    assert out["approved"] == []
    denied = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert denied and "already attempted" in denied[0].content
