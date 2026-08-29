"""gate — the interceptor node (docs/harness.md §3, §6.1).

Checks, in order, before any tool runs:
  1. Budget  — token spend + tool-call count under caps? If not → HALT the run
               (partial report), don't just block the one call (§3, §6.2).
  2. Schema  — validate the tool call against its schema. Malformed → fail closed,
               return tool_result(is_error) with a corrective message; agent
               retries. Never execute a half-parsed call (§6.1.1).
  3. Scope   — is the call's target in the allowlist? Delegates to scope_check.py.
  4. Repeat  — identical call already tried? loop_guard.py may reject it (§6.1.3).

Budget is a whole-run halt (routes to END → partial report). Schema / scope /
repeat are PER-CALL denies: the call gets a corrective tool_result(is_error) and
the agent adapts — the run continues. A turn's calls are partitioned into
`approved` (forwarded to the tool node) and denied (error ToolMessages emitted
here); every tool_call id gets a response either way, so the transcript stays
well-formed for the next agent turn.

Fail-closed is the invariant: any error screening a call → deny that call; any
error in the budget/systemic path → HALT. Never default-allow.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, ToolMessage

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.contracts.state import EngagementState
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.interceptor import loop_guard, scope_check
from autosploit_harness.ledger.store import Ledger
from autosploit_harness.tools import registry


def _pending_tool_calls(state: EngagementState) -> list[dict]:
    """The tool calls the agent just emitted (last message), or []."""
    messages = state.get("messages") or []
    if not messages:
        return []
    last = messages[-1]
    if isinstance(last, AIMessage):
        return list(last.tool_calls or [])
    return []


def _pending_invalid_tool_calls(state: EngagementState) -> list[dict]:
    """Calls the model emitted that LangChain could not parse (bad JSON args, etc).

    These arrive as `invalid_tool_calls` — the API still counted them as tool
    calls, so each needs a tool_result response or the next turn is malformed. The
    gate turns each into a corrective tool_result so the agent reissues it well-
    formed (§6.1.1). Never executed — a half-parsed call never reaches a tool.
    """
    messages = state.get("messages") or []
    if not messages:
        return []
    last = messages[-1]
    if isinstance(last, AIMessage):
        return list(getattr(last, "invalid_tool_calls", None) or [])
    return []


def _screen_call(
    call: dict[str, Any], *, scope: ScopeAllowlist, ledger: Ledger
) -> str | None:
    """Screen one call: schema → scope → repeat. None = allow, str = deny reason.

    Fail-closed: any exception here is treated as a deny (with the error as the
    reason), never a silent allow.
    """
    name = call.get("name")
    args = call.get("args") or {}
    try:
        # 2. Schema — validate args against the strict schema (§6.1.1).
        schema = registry.SCHEMAS.get(name)
        if schema is None:
            return f"unknown tool: {name!r}"
        try:
            schema(**args)
        except Exception as e:  # noqa: BLE001  pydantic ValidationError → corrective deny
            return f"invalid arguments for {name}: {e}"

        # 3. Scope — structured target check for http_request (§3).
        reason = scope_check.out_of_scope(name, args, scope)
        if reason is not None:
            return reason

        # 4. Repeat — identical call already tried? (§6.1.3)
        reason = loop_guard.is_repeat(name, args, ledger.attempts)
        if reason is not None:
            return reason

        return None
    except Exception as e:  # noqa: BLE001  screening error → deny this call, never allow
        return f"interceptor could not screen {name}: {e!r}"


def interceptor_node(
    state: EngagementState,
    *,
    budget: BudgetState,
    emitter: JsonlEmitter,
    scope: ScopeAllowlist,
    ledger: Ledger,
) -> dict:
    """Deterministic gate. NO LLM. Fail-closed. Runs before any tool executes.

    Budget halt is whole-run; schema/scope/repeat are per-call denies. Returns
    `approved` (calls the tool node runs) plus error ToolMessages for denied
    calls. Any systemic exception → HALT (never default-allow).
    """
    try:
        calls = _pending_tool_calls(state)

        # 1. Budget — is a cap already crossed? If so, halt the whole run.
        reason = budget.over_cap()
        if reason is not None:
            emitter.emit("halt", {"cause": "budget", "reason": reason, **budget.totals()})
            return {"halt": reason, "budget": budget, "approved": []}

        approved: list[dict] = []
        denied_messages: list[ToolMessage] = []

        # Malformed calls the model emitted (unparseable args): fail closed with a
        # corrective tool_result so the agent reissues them well-formed (§6.1.1).
        for bad in _pending_invalid_tool_calls(state):
            name = bad.get("name") or "unknown"
            error = bad.get("error") or "arguments could not be parsed"
            reason = (
                f"malformed call to {name}: {error}. Reissue it as a single "
                f"well-formed tool call with valid JSON arguments."
            )
            emitter.emit(
                "tool_result",
                {"id": bad.get("id"), "name": name, "is_error": True, "error": reason},
            )
            denied_messages.append(
                ToolMessage(
                    content=reason, tool_call_id=bad.get("id"), status="error"
                )
            )

        for call in calls:
            deny_reason = _screen_call(call, scope=scope, ledger=ledger)
            if deny_reason is None:
                approved.append(call)
            else:
                emitter.emit(
                    "tool_result",
                    {
                        "id": call.get("id"),
                        "name": call.get("name"),
                        "is_error": True,
                        "error": deny_reason,
                    },
                )
                denied_messages.append(
                    ToolMessage(
                        content=deny_reason,
                        tool_call_id=call.get("id"),
                        status="error",
                    )
                )

        # Count approved calls (the cheap runaway-loop guard, §6.2) and log each
        # as a tool_call event — the gate "budget-gates and logs" every allowed
        # call (§3). Denied calls are not counted against the budget.
        budget.record_tool_call(len(approved))
        for call in approved:
            emitter.emit(
                "tool_call",
                {"name": call.get("name"), "args": call.get("args"), "id": call.get("id")},
            )
        emitter.emit("cost", budget.totals())

        return {"budget": budget, "approved": approved, "messages": denied_messages}
    except Exception as e:  # noqa: BLE001  fail-closed: ANY systemic error → HALT (§3)
        emitter.emit("halt", {"cause": "interceptor_error", "reason": repr(e)})
        return {"halt": f"interceptor error: {e!r}", "budget": budget, "approved": []}


def route_after_interceptor(state: EngagementState) -> str:
    """Conditional edge: halted → END; any approved calls → tools; else → agent.

    All-denied turns route back to the agent (it reads the corrective
    tool_results and adapts) without touching a subprocess (§3).
    """
    if state.get("halt"):
        return "halt"
    if state.get("approved"):
        return "tools"
    return "agent"
