"""metrics — the model-choice risk metric (docs/harness.md §6.1, §8).

Tool-call success rate: fraction of tool calls that are well-formed + valid +
executed (not blocked by schema validation or malformed args). This is the §6.1
risk metric and it drives the DeepSeek / Kimi / GLM model decision — the
OpenRouter swap makes that a config sweep, not a rewrite. Reads the event stream;
paired with score.py's exploit score to decide the primary model from data.

Every tool call the agent emits gets exactly one `tool_result` event: the gate
emits it for a denied/malformed call (§3, §6.1.1), the tool node emits it for an
executed one (nodes.tool_node). So `tool_result` events ARE the attempted calls —
count them, and split by `is_error` and the deny-reason text into the buckets the
sweep reads. The category strings key off the exact reasons the interceptor and
tool node write, so classification is deterministic, not a guess.

Two rates, two lenses:
  - success_rate     = executed / attempts. The literal §8 "well-formed + valid +
                       executed" metric — did the call actually run?
  - well_formed_rate = (attempts - malformed - schema_invalid - unknown_tool) /
                       attempts. The purer model-tool-use-quality cut: scope and
                       repeat denials are the interceptor's POLICY, and an adapter
                       error is the TARGET's fault — none of the three is the model
                       emitting a bad call. This is the number to weigh a model on.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ToolCallMetrics:
    """Tool-call outcome tally for one run (§6.1, §8).

    `attempts` is every call the agent emitted; `executed` is the ones that ran.
    The failure buckets are mutually exclusive and sum to `attempts - executed`.
    """

    attempts: int
    executed: int
    malformed: int  # unparseable args — model emitted broken JSON (§6.1.1)
    schema_invalid: int  # parsed but failed the strict schema (§6.1.1)
    out_of_scope: int  # well-formed, denied by the scope gate (§3)
    repeat: int  # identical call already tried, loop-guard denied (§6.1.3)
    unknown_tool: int  # a tool name the registry does not know
    adapter_error: int  # executed and the adapter raised — target-side, not model

    @property
    def success_rate(self) -> float:
        """executed / attempts — the literal §8 tool-call success rate."""
        return self.executed / self.attempts if self.attempts else 0.0

    @property
    def well_formed_rate(self) -> float:
        """Share of calls the model emitted well-formed + valid (§6.1).

        Excludes the three non-model failures (scope, repeat, adapter) from the
        numerator's complement — those are policy / target, not tool-use quality.
        """
        if not self.attempts:
            return 0.0
        model_faults = self.malformed + self.schema_invalid + self.unknown_tool
        return (self.attempts - model_faults) / self.attempts

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempts": self.attempts,
            "executed": self.executed,
            "success_rate": round(self.success_rate, 4),
            "well_formed_rate": round(self.well_formed_rate, 4),
            "failures": {
                "malformed": self.malformed,
                "schema_invalid": self.schema_invalid,
                "out_of_scope": self.out_of_scope,
                "repeat": self.repeat,
                "unknown_tool": self.unknown_tool,
                "adapter_error": self.adapter_error,
            },
        }


def _classify(error: str) -> str:
    """Map a tool_result error string to a failure bucket.

    Keys off the exact reasons the interceptor (gate.py, scope_check.py,
    loop_guard.py) and the tool node (nodes.py) write, checked most-specific
    first. An unrecognized error is an adapter_error (an executed call raised —
    tool_node emits repr(exc), which matches nothing above)."""
    text = error.lower()
    if "malformed call to" in text:
        return "malformed"
    if "invalid arguments for" in text:
        return "schema_invalid"
    if "already attempted" in text:  # loop_guard repeat deny (§6.1.3)
        return "repeat"
    if (
        "out of scope" in text
        or "scope check" in text  # "required for the scope check"
        or "could not parse a host" in text
        or "could not determine a port" in text
    ):
        return "out_of_scope"
    if "unknown tool" in text:
        return "unknown_tool"
    return "adapter_error"


def tool_call_metrics(events: list[dict[str, Any]]) -> ToolCallMetrics:
    """Tally tool-call outcomes from a run's event stream (§6.1, §8).

    One `tool_result` event == one attempted call. `is_error` False → executed;
    True → bucketed by its error text. This is the metric that, paired with the
    exploit score, drives the primary-model decision from data (§8)."""
    counts = {
        "malformed": 0,
        "schema_invalid": 0,
        "out_of_scope": 0,
        "repeat": 0,
        "unknown_tool": 0,
        "adapter_error": 0,
    }
    attempts = 0
    executed = 0
    for event in events:
        if event.get("type") != "tool_result":
            continue
        attempts += 1
        data = event.get("data") or {}
        if data.get("is_error"):
            counts[_classify(str(data.get("error") or ""))] += 1
        else:
            executed += 1

    return ToolCallMetrics(attempts=attempts, executed=executed, **counts)
