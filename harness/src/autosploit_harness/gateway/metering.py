"""metering — cost measurement (docs/harness.md §6.2).

The gateway MEASURES; the interceptor ENFORCES (§3). Reads OpenRouter's per-
response usage (prompt_tokens, completion_tokens) and — when the request asked
for it (`extra_body={"usage": {"include": true}}`, wired in client.py) — the exact
USD `cost` OpenRouter attaches to that usage block. Cost is READ, never hardcoded:
prices move, so an un-metered turn adds $0 rather than a stale estimate (§6.2).

Feeds the shared BudgetState (budget/state.py) and emits a `cost` event each turn
(§7). Tracks token + USD (the billing basis reused as per-user quota later,
overview.md §8); the tool-call count is the interceptor's own cheap runaway guard.

Step 3 (§9): this is the wiring that makes the token/USD caps bite. Until now the
meter was a stub and the tool-call count was the only live guard; agent_node calls
meter_turn() after every model turn so the totals reflect real spend.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.events.emitter import JsonlEmitter


@dataclass(frozen=True, slots=True)
class Usage:
    """One turn's measured spend, extracted from a model response."""

    prompt_tokens: int
    completion_tokens: int
    usd: float

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


def _as_mapping(obj: Any) -> dict:
    """Best-effort dict view of a usage-ish object (dict or pydantic/attrs)."""
    if isinstance(obj, dict):
        return obj
    for attr in ("model_dump", "dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                dumped = fn()
            except Exception:  # noqa: BLE001  best-effort — a bad accessor just yields {}
                dumped = None
            if isinstance(dumped, dict):
                return dict(dumped)
    return {}


def _find_cost(usage: dict) -> float:
    """Pull OpenRouter's USD cost out of a usage mapping, else 0.0.

    OpenRouter puts it at `usage.cost` when the request opts in; some routes nest
    a `cost_details.upstream_inference_cost` / `total_cost`. Read whatever is
    there; never estimate from a hardcoded price (§6.2).
    """
    for key in ("cost", "total_cost"):
        val = usage.get(key)
        if isinstance(val, int | float):
            return float(val)
    details = usage.get("cost_details")
    if isinstance(details, dict):
        total = details.get("total_cost") or details.get("upstream_inference_cost")
        if isinstance(total, int | float):
            return float(total)
    return 0.0


def extract_usage(response: Any) -> Usage:
    """Extract (prompt, completion, usd) from a LangChain model response.

    Prefers LangChain's normalized `usage_metadata` for tokens; falls back to the
    raw provider `usage`/`token_usage` in `response_metadata`. Cost comes from the
    raw usage block (that is where OpenRouter attaches it). Missing everything →
    a zero-usage turn (a fake-model test, or a provider that returned no usage).
    """
    um = getattr(response, "usage_metadata", None) or {}
    prompt = int(um.get("input_tokens", 0) or 0)
    completion = int(um.get("output_tokens", 0) or 0)

    meta = getattr(response, "response_metadata", None) or {}
    raw = _as_mapping(meta.get("token_usage") or meta.get("usage") or {})
    if not prompt:
        prompt = int(raw.get("prompt_tokens", 0) or 0)
    if not completion:
        completion = int(raw.get("completion_tokens", 0) or 0)

    usd = _find_cost(raw) or _find_cost(_as_mapping(um))
    return Usage(prompt_tokens=prompt, completion_tokens=completion, usd=usd)


def meter_turn(response: Any, budget: BudgetState, emitter: JsonlEmitter) -> Usage:
    """Record a turn's spend into the budget and emit a `cost` event (§6.2, §7).

    Returns the extracted Usage. Called by agent_node right after model.invoke, so
    the token/USD totals the interceptor tests against are current before the next
    tool step is screened.
    """
    usage = extract_usage(response)
    budget.record_usage(usage.prompt_tokens, usage.completion_tokens, usage.usd)
    emitter.emit(
        "cost",
        {
            **budget.totals(),
            "turn": {
                "prompt_tokens": usage.prompt_tokens,
                "completion_tokens": usage.completion_tokens,
                "usd": round(usage.usd, 6),
            },
        },
    )
    return usage
