"""nodes — the agent turn + conditional edges (docs/harness.md §2, §6.1).

  - agent_node: one LLM turn — reason + emit tool call(s). Meters the turn's spend
    into the budget and emits a cost event (§6.2), surfaces any reasoning content
    to the event stream (§6), and flags a provider-policy refusal (§6.1.4).
  - route_after_agent: conditional edge — engagement_complete? → complete node;
    any tool call (valid OR malformed)? → interceptor; bare prose? → recover
    (the prose-instead-of-tool nudge, §6.1.2).
  - tool_node: executes the interceptor-approved tool calls, spills FULL output to
    the ledger, records the attempt, and appends a truncated preview to the
    transcript (a custom node, NOT LangGraph's prebuilt ToolNode — the gate sits
    in front of it, §2).
  - recover_node: the prose nudge (§6.1.2). A bare-prose turn gets a reminder to
    use a tool or finish; past the nudge cap the run ends rather than looping.
  - complete_node: handles engagement_complete — reads the summary, emits the
    end phase, ends the run with a full report (§4, §5).

Node functions only; graph assembly is graph.py.

Step 3 (§9 gateway hardening): metering wired here (meter_turn), malformed calls
recovered at the gate + this file's routing, and the prose nudge (recover_node)
lands with a run-scoped cap.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from autosploit_harness.agent.prompts import system_prompt
from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.state import EngagementState
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.gateway import fallback
from autosploit_harness.gateway.metering import meter_turn
from autosploit_harness.ledger import context
from autosploit_harness.ledger.store import Ledger
from autosploit_harness.tools import registry
from autosploit_harness.tools.truncate import truncate

# Prose-instead-of-tool nudges allowed per run before a bare turn ends it (§6.1.2).
MAX_NUDGES = 2

_NUDGE_REMINDER = (
    "You replied with prose but issued no tool call. The engagement runs through "
    "tools only: call run_shell, http_request, or note_finding to keep going, or "
    "call engagement_complete to finish and hand back a summary. Do not answer in "
    "prose alone."
)


def agent_node(
    state: EngagementState, *, model, budget: BudgetState, emitter: JsonlEmitter
) -> dict:
    """One LLM turn. Prepends the scoped system prompt, invokes the bound model,
    meters the spend (§6.2), surfaces reasoning (§6), flags refusals (§6.1.4)."""
    messages = state["messages"]
    # Client-side context folding (§5): trim stale tool results / summarize older
    # turns so a long engagement doesn't overrun the model window. Applied to the
    # PROMPT COPY only — the durable state + ledger stay whole. No-op on a generous
    # window (the common case), so it costs nothing until a run actually grows.
    folded = context.fold_transcript(messages, emitter=emitter)
    prompt = [SystemMessage(content=system_prompt(state["scope"]))] + list(folded)
    response = model.invoke(prompt)

    # Meter this turn into the shared budget + emit a cost event (§6.2, §7). Runs
    # before the interceptor screens the next step, so token/USD caps are current.
    meter_turn(response, budget, emitter)

    # Surface reasoning content if the provider returned any (§6) — dashboard
    # shows thinking, not a silent pause.
    reasoning = None
    if isinstance(response, AIMessage):
        reasoning = (response.additional_kwargs or {}).get("reasoning_content")
    if reasoning:
        emitter.emit("phase", {"stage": "thinking", "reasoning": reasoning})

    # Provider-policy refusal / empty completion → emit a refusal event (§6.1.4).
    if fallback.is_refusal(response):
        emitter.emit(
            "refusal",
            {"reason": "provider refusal or empty completion", "model": _model_name(response)},
        )

    return {"messages": [response]}


def _model_name(response: Any) -> str | None:
    meta = getattr(response, "response_metadata", None) or {}
    return meta.get("model_name") or meta.get("model")


def route_after_agent(state: EngagementState) -> str:
    """engagement_complete → complete; any tool call → interceptor; else → recover.

    A malformed call (invalid_tool_calls) still routes to the interceptor: the
    gate turns it into a corrective tool_result so the agent retries (§6.1.1). A
    turn with no call at all is prose — the recover node nudges it (§6.1.2).
    """
    last = state["messages"][-1]
    if isinstance(last, AIMessage):
        if last.tool_calls:
            names = {c.get("name") for c in last.tool_calls}
            if names & registry.TERMINAL_TOOLS:
                return "complete"
            return "interceptor"
        if getattr(last, "invalid_tool_calls", None):
            return "interceptor"
        return "recover"
    return "end"


def recover_node(state: EngagementState, *, emitter: JsonlEmitter) -> dict:
    """Prose-instead-of-tool nudge (§6.1.2). Bounded so it can't loop forever.

    Under the cap: append a system reminder and route back to the agent. At the
    cap: end the run cleanly (the model has stopped calling tools — accept the
    stop rather than pester it, or spin to the recursion limit).
    """
    nudges = (state.get("nudges") or 0) + 1
    if nudges > MAX_NUDGES:
        emitter.emit("phase", {"stage": "end", "cause": "no_tool_call", "nudges": nudges - 1})
        return {"nudges": nudges}
    emitter.emit("phase", {"stage": "nudge", "attempt": nudges})
    return {"messages": [HumanMessage(content=_NUDGE_REMINDER)], "nudges": nudges}


def route_after_recover(state: EngagementState) -> str:
    """Back to the agent while nudges remain; once spent, end the run."""
    if (state.get("nudges") or 0) > MAX_NUDGES:
        return "end"
    return "agent"


def tool_node(
    state: EngagementState,
    *,
    emitter: JsonlEmitter,
    callables: dict[str, Callable[..., Any]],
    ledger: Ledger,
) -> dict:
    """Execute the interceptor-approved tool calls, spill FULL output to the
    ledger, record each attempt, emit tool_result, and append a truncated preview
    ToolMessage per call so the agent sees the outcome next turn.

    Truncation lives HERE now (§9 step 3): the adapter returns full output, this
    node writes the full text to the ledger (addressable by call id) and hands the
    transcript a capped preview plus the on-disk path the agent can `run_shell
    cat` — so the ledger holds full-before-truncate, not an already-clipped copy.

    Runs ONLY state["approved"] — denied calls already got an error tool_result
    from the gate (§3), so this never re-touches them.
    """
    approved = state.get("approved") or []
    out_messages: list[ToolMessage] = []

    for call in approved:
        name = call["name"]
        args = call.get("args", {}) or {}
        call_id = call.get("id")
        adapter = callables.get(name)

        if adapter is None:
            content = f"unknown tool: {name!r}"
            emitter.emit(
                "tool_result",
                {"id": call_id, "name": name, "is_error": True, "error": content},
            )
            out_messages.append(
                ToolMessage(content=content, tool_call_id=call_id, status="error")
            )
            ledger.attempts.record(name, args, result=content)
            continue

        try:
            result = adapter(**args)
            full = registry.render_result(result)  # full, un-truncated
            # Full output → ledger (addressable by call id, §5); transcript keeps a
            # capped preview + the path so the agent can recover the rest (§4, §5).
            out_path = ledger.write_output(call_id, name, full)
            preview, truncated = truncate(full)
            content = preview
            if truncated:
                content += (
                    f"\n[output truncated — full text on disk at "
                    f"outputs/{out_path.name}; `run_shell` `cat` it to read the rest]"
                )
            ledger.attempts.record(name, args, result=preview)
            emitter.emit(
                "tool_result",
                {
                    "id": call_id,
                    "name": name,
                    "is_error": False,
                    "truncated": truncated,
                    **registry.event_payload(result),
                },
            )
            out_messages.append(ToolMessage(content=content, tool_call_id=call_id))
        except Exception as e:  # noqa: BLE001  adapter failure is a tool_result, not a crash
            content = f"tool {name} raised: {e!r}"
            ledger.attempts.record(name, args, result=content)
            emitter.emit(
                "tool_result",
                {"id": call_id, "name": name, "is_error": True, "error": repr(e)},
            )
            out_messages.append(
                ToolMessage(content=content, tool_call_id=call_id, status="error")
            )

    return {"messages": out_messages, "approved": []}


def complete_node(state: EngagementState, *, emitter: JsonlEmitter) -> dict:
    """Handle engagement_complete: read the summary, emit the end phase, end the
    run with a full report (§4, §5). Terminal — routed straight to END, so the
    engagement_complete tool_call needs no ToolMessage response."""
    last = state["messages"][-1]
    calls = last.tool_calls if isinstance(last, AIMessage) else []
    summary = ""
    for call in calls:
        if call.get("name") in registry.TERMINAL_TOOLS:
            summary = (call.get("args") or {}).get("summary", "") or ""
            break
    emitter.emit("phase", {"stage": "complete", "summary": summary})
    return {"completed_summary": summary, "phase": "complete"}
