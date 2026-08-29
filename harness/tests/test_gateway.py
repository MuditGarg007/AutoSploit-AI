"""Gateway tests (docs/harness.md §6, §6.1.4, §6.2) — the model-provider seam.

Covers the step-3 hardening that runs without a network:
  - metering: extract usage (tokens + OpenRouter USD cost) from a response and
    record it into the budget + emit a cost event.
  - refusal detection: an empty / policy-refusal completion is flagged (§6.1.4).
  - availability fallback: the OpenRouter `models` array is assembled primary-first.
  - extra_body: reasoning + fallbacks + usage-cost opt-in are shaped correctly.

No OpenRouter, no ChatOpenAI — a plain stand-in response object carries the same
`usage_metadata` / `response_metadata` LangChain would populate.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from langchain_core.messages import AIMessage

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.gateway import fallback
from autosploit_harness.gateway.client import build_extra_body
from autosploit_harness.gateway.metering import extract_usage, meter_turn


@dataclass
class FakeResponse:
    """Stands in for a LangChain model response with usage attached."""

    usage_metadata: dict = field(default_factory=dict)
    response_metadata: dict = field(default_factory=dict)


def test_extract_usage_reads_tokens_and_cost():
    resp = FakeResponse(
        usage_metadata={"input_tokens": 1200, "output_tokens": 340},
        response_metadata={"token_usage": {"prompt_tokens": 1200, "completion_tokens": 340, "cost": 0.0025}},
    )
    usage = extract_usage(resp)
    assert usage.prompt_tokens == 1200
    assert usage.completion_tokens == 340
    assert usage.total_tokens == 1540
    assert usage.usd == 0.0025


def test_extract_usage_falls_back_to_raw_usage():
    """No normalized usage_metadata → read the raw provider usage block."""
    resp = FakeResponse(
        response_metadata={"usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost_details": {"total_cost": 0.001}}}
    )
    usage = extract_usage(resp)
    assert (usage.prompt_tokens, usage.completion_tokens) == (10, 5)
    assert usage.usd == 0.001


def test_extract_usage_missing_is_zero():
    """A fake-model turn with no usage meters to zero, never crashes."""
    usage = extract_usage(FakeResponse())
    assert (usage.prompt_tokens, usage.completion_tokens, usage.usd) == (0, 0, 0.0)


def test_meter_turn_records_and_emits():
    budget = BudgetState(max_tokens=10_000, max_usd=1.0)
    emitter = JsonlEmitter(path=None, stdout=False)
    resp = FakeResponse(
        usage_metadata={"input_tokens": 100, "output_tokens": 50},
        response_metadata={"token_usage": {"cost": 0.002}},
    )

    meter_turn(resp, budget, emitter)

    assert budget.tokens == 150
    assert budget.usd == 0.002
    cost_events = [e for e in emitter.events if e["type"] == "cost"]
    assert cost_events and cost_events[-1]["data"]["tokens"] == 150
    assert cost_events[-1]["data"]["turn"]["usd"] == 0.002


def test_meter_feeds_token_cap():
    """Metered tokens make the token cap real — over_cap fires once fed (§6.2)."""
    budget = BudgetState(max_tokens=100)
    emitter = JsonlEmitter(path=None, stdout=False)
    assert budget.over_cap() is None
    meter_turn(
        FakeResponse(usage_metadata={"input_tokens": 80, "output_tokens": 40}),
        budget,
        emitter,
    )
    assert budget.over_cap() is not None
    assert "token cap" in budget.over_cap()


def test_is_refusal_detects_empty_and_refusal():
    assert fallback.is_refusal(AIMessage(content="")) is True
    assert fallback.is_refusal(AIMessage(content="I can't help with that request.")) is True


def test_is_refusal_ignores_normal_prose_and_tool_calls():
    # Prose without a tool call is the nudge path, not a refusal.
    assert fallback.is_refusal(AIMessage(content="Let me scan the target next.")) is False
    # A completion that emitted a tool call is never a refusal.
    with_tool = AIMessage(
        content="",
        tool_calls=[{"name": "run_shell", "args": {"cmd": "id"}, "id": "t1"}],
    )
    assert fallback.is_refusal(with_tool) is False


def test_model_list_primary_first_deduped():
    assert fallback.model_list("a", ("b", "c", "a")) == ["a", "b", "c"]
    assert fallback.model_list("a", ()) == ["a"]


def test_build_extra_body_shapes_openrouter_fields():
    body = build_extra_body("primary", reasoning="high", fallbacks=("kimi", "glm"))
    assert body["usage"] == {"include": True}
    assert body["reasoning"] == {"effort": "high"}
    assert body["models"] == ["primary", "kimi", "glm"]

    # Bare run: only the usage opt-in, no reasoning / models keys.
    bare = build_extra_body("primary")
    assert bare == {"usage": {"include": True}}

    # reasoning "off" is treated as unset.
    assert "reasoning" not in build_extra_body("primary", reasoning="off")
