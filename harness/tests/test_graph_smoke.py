"""Graph smoke test (docs/harness.md §9 step 1 + step 2).

The loop proof: LangGraph graph with the full tool surface + the interceptor node
+ JSONL events, pointed at a target. Asserts the graph runs a tool call, crosses
the interceptor, and comes back to the agent — plus the step-2 exits: a finding
lands in the ledger and engagement_complete ends the run with a full report.

Uses a fake chat model (no OpenRouter, no network): the agent slice only ever
sees an already-invoke-ready model, so the fake drops straight in.
"""

from __future__ import annotations

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.driver.run import run_engagement
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.ledger.store import Ledger

SCOPE = ScopeAllowlist(host="127.0.0.1", ports=(3000,))


def _fake_model(responses):
    return FakeMessagesListChatModel(responses=responses)


def _emitter():
    return JsonlEmitter(path=None, stdout=False)


def test_graph_runs_tool_and_returns(tmp_path):
    """agent → interceptor → tools → agent, then engagement_complete ends the run."""
    model = _fake_model([
        AIMessage(
            content="Recon: probe the shell.",
            tool_calls=[{"name": "run_shell", "args": {"cmd": "echo skeleton-ok", "timeout": 5}, "id": "c1"}],
        ),
        AIMessage(
            content="Done.",
            tool_calls=[{"name": "engagement_complete", "args": {"summary": "probe ok"}, "id": "done"}],
        ),
    ])
    budget = BudgetState(max_tool_calls=60)
    emitter = _emitter()
    ledger = Ledger(tmp_path)

    report, final_state = run_engagement(
        model=model, scope=SCOPE, budget=budget, emitter=emitter, ledger=ledger
    )

    # The tool executed and its output came back into the transcript.
    tool_msgs = [m for m in final_state["messages"] if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert "skeleton-ok" in tool_msgs[0].content

    # The loop returned to the agent and then finished cleanly (no halt).
    assert report.completed is True
    assert report.tool_results == 1
    assert budget.tool_calls == 1

    # The interceptor was crossed: a tool_call event and a cost event fired.
    types = [e["type"] for e in emitter.events]
    assert "tool_call" in types
    assert "cost" in types
    assert "tool_result" in types

    # The attempt was recorded to the on-disk ledger (§5).
    assert report.attempts == 1
    assert ledger.attempts.seen("run_shell", {"cmd": "echo skeleton-ok", "timeout": 5})


def test_budget_cap_halts_the_run(tmp_path):
    """A tool-call cap crosses → interceptor halts (partial report), not a crash."""
    model = _fake_model([
        AIMessage(
            content="one",
            tool_calls=[{"name": "run_shell", "args": {"cmd": "echo one", "timeout": 5}, "id": "a"}],
        ),
        AIMessage(
            content="two",
            tool_calls=[{"name": "run_shell", "args": {"cmd": "echo two", "timeout": 5}, "id": "b"}],
        ),
        AIMessage(content="unreachable"),
    ])
    budget = BudgetState(max_tool_calls=1)  # exactly one tool call allowed
    emitter = _emitter()
    ledger = Ledger(tmp_path)

    report, _ = run_engagement(
        model=model, scope=SCOPE, budget=budget, emitter=emitter, ledger=ledger
    )

    assert report.completed is False
    assert report.halt_reason is not None
    assert "tool-call cap" in report.halt_reason
    assert report.tool_results == 1  # first call ran; second was halted before executing

    halts = [e for e in emitter.events if e["type"] == "halt"]
    assert any(e["data"].get("cause") == "budget" for e in halts)


def test_note_finding_and_complete(tmp_path):
    """A finding lands in the ledger; engagement_complete ends with a full report."""
    model = _fake_model([
        AIMessage(
            content="Confirmed SQLi.",
            tool_calls=[{
                "name": "note_finding",
                "args": {
                    "title": "UNION SQLi on /rest/products/search",
                    "severity": "critical",
                    "evidence": "dumped sqlite_master",
                    "repro": "q=')) UNION SELECT ...",
                },
                "id": "f1",
            }],
        ),
        AIMessage(
            content="Wrapping up.",
            tool_calls=[{"name": "engagement_complete", "args": {"summary": "1 critical SQLi"}, "id": "done"}],
        ),
    ])
    budget = BudgetState(max_tool_calls=60)
    emitter = _emitter()
    ledger = Ledger(tmp_path)

    report, _ = run_engagement(
        model=model, scope=SCOPE, budget=budget, emitter=emitter, ledger=ledger
    )

    # Finding persisted to disk and surfaced in the report + event stream.
    assert len(report.findings) == 1
    assert report.findings[0]["severity"] == "critical"
    assert report.findings[0]["id"] == "F-001"
    assert any(e["type"] == "finding" for e in emitter.events)

    # engagement_complete → full report carrying the agent's summary.
    assert report.completed is True
    assert report.summary == "1 critical SQLi"


def test_prose_nudge_then_tool(tmp_path):
    """A prose-only turn is nudged (§6.1.2), then the agent tools up and finishes."""
    model = _fake_model([
        AIMessage(content="I think the login form looks interesting."),  # no tool call
        AIMessage(
            content="Finishing.",
            tool_calls=[{"name": "engagement_complete", "args": {"summary": "done"}, "id": "z"}],
        ),
    ])
    budget = BudgetState(max_tool_calls=60)
    emitter = _emitter()
    ledger = Ledger(tmp_path)

    report, _ = run_engagement(
        model=model, scope=SCOPE, budget=budget, emitter=emitter, ledger=ledger
    )

    # The bare-prose turn produced a nudge phase event, not an early end.
    assert any(e["type"] == "phase" and e["data"].get("stage") == "nudge" for e in emitter.events)
    assert report.completed is True
    assert report.summary == "done"


def test_prose_nudge_cap_ends_run(tmp_path):
    """The agent that only ever emits prose is nudged up to the cap, then the run
    ends cleanly (no halt) rather than spinning to the recursion limit (§6.1.2)."""
    from autosploit_harness.agent.nodes import MAX_NUDGES

    # Distinct ids per turn: a real model returns fresh messages, so add_messages
    # appends each. (One reused instance would be de-duped by id and collapse.)
    model = _fake_model([
        AIMessage(content="just talking, no tools", id=f"p{i}") for i in range(MAX_NUDGES + 1)
    ])
    budget = BudgetState(max_tool_calls=60)
    emitter = _emitter()
    ledger = Ledger(tmp_path)

    report, _ = run_engagement(
        model=model, scope=SCOPE, budget=budget, emitter=emitter, ledger=ledger
    )

    nudges = [e for e in emitter.events if e["type"] == "phase" and e["data"].get("stage") == "nudge"]
    assert len(nudges) == MAX_NUDGES  # nudged the cap number of times, then stopped
    assert report.completed is True   # clean end, not a halt
    assert report.halt_reason is None
