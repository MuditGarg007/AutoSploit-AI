"""Event schema (docs/harness.md §7) — the one seam the dashboard depends on.

Standalone this is JSONL; production is an SSE gateway. Same schema either way,
so freeze it early — it's the contract two languages meet at.

    {"ts", "type": phase|tool_call|tool_result|finding|cost|refusal|halt, "data"}

Two layers, both frozen (§9 step 5):
  - the envelope (Event): ts + type + data — stamped by make_event().
  - the per-type `data` payloads (below): what each event type actually carries.
    Before step 5 `data` was an open dict[str, Any]; the fields lived only in the
    scattered emit() call sites. Pinning them here is what lets the TS control
    plane read an event without reverse-engineering the emitter.

Payload shapes use Required/NotRequired so the required key set is machine-readable
(__required_keys__), which contracts/export.py reflects into the exported descriptor
and validate_event() enforces. No emission logic here — that's events/emitter.py.
This file is shape only: the EventType literal, the payload TypedDicts, make_event()
(stamps the envelope), and validate_event() (a payload's required keys are present).
"""

# NOTE: no `from __future__ import annotations` here on purpose. String
# annotations would hide the Required[]/NotRequired[] wrappers from TypedDict at
# class-creation time, leaving __required_keys__ empty — and that set is exactly
# what export.py reflects and validate_event() enforces. Keep annotations live.
from datetime import UTC, datetime
from typing import Any, Literal, NotRequired, Required, TypedDict

EventType = Literal[
    "phase",
    "tool_call",
    "tool_result",
    "finding",
    "cost",
    "refusal",
    "halt",
]


class Event(TypedDict):
    """The event envelope. Frozen seam (§7) — two languages meet here."""

    ts: str
    type: EventType
    data: dict[str, Any]


# --- per-type `data` payload shapes (frozen, §9 step 5) ---------------------
#
# total=False everywhere so a payload is a plain dict; Required[...] marks the
# keys that MUST be present (reflected as __required_keys__). Optional keys are
# the fields an emit site adds situationally.


class PhaseData(TypedDict, total=False):
    """`phase` — the agent's self-declared stage (recon/exploit/...). Emitted,
    never enforced (§7). `stage` is the only invariant; the rest ride per stage
    (e.g. thinking→reasoning, nudge→attempt, start→host/ports, complete→summary).
    An end-stage phase additionally spills the report fields (driver.report)."""

    stage: Required[str]
    host: NotRequired[str]
    ports: NotRequired[list[int]]
    reasoning: NotRequired[str]
    cause: NotRequired[str]
    attempt: NotRequired[int]
    nudges: NotRequired[int]
    summary: NotRequired[str]


class ToolCallData(TypedDict, total=False):
    """`tool_call` — one per interceptor-approved call (§3). `args` is the
    validated tool arguments; `id` is the model's tool-call id (may be null)."""

    name: Required[str]
    id: Required[str | None]
    args: NotRequired[dict[str, Any]]


class ToolResultData(TypedDict, total=False):
    """`tool_result` — one per action. `is_error` splits the two shapes:
    on error, `error` carries the message (denied call, malformed args, adapter
    raise); on success, the payload extends with the matching result shape from
    the `results` section (ShellResult/HttpResult/FindingId/CompleteResult),
    with long text fields (stdout/stderr/body) truncated for the stream."""

    id: Required[str | None]
    name: Required[str | None]
    is_error: Required[bool]
    error: NotRequired[str]
    truncated: NotRequired[bool]


class FindingData(TypedDict, total=False):
    """`finding` — the scored artifact, from note_finding (§5). Mirrors the
    ledger record; `id` is the ledger handle (e.g. F-001)."""

    id: Required[str]
    title: Required[str]
    severity: Required[str]
    evidence: Required[str]
    repro: Required[str]


class CostData(TypedDict, total=False):
    """`cost` — running budget totals (§6.2), the billing basis. `caps` echoes
    the configured limits; `turn` (when present) is the just-metered turn's spend."""

    tokens: Required[int]
    usd: Required[float]
    tool_calls: Required[int]
    caps: Required[dict[str, Any]]
    turn: NotRequired[dict[str, Any]]


class RefusalData(TypedDict, total=False):
    """`refusal` — a provider-policy refusal or empty completion (§6.1.4). Emitted
    as a run event before falling to the next model in the list."""

    reason: Required[str]
    model: NotRequired[str | None]


class HaltData(TypedDict, total=False):
    """`halt` — the loop stopped and why. `cause` is the discriminator
    (budget | interceptor_error | ...); a budget halt also spills the totals.
    The driver's end-halt (clean finish path) carries the report fields instead,
    so no single key is invariant across every halt."""

    cause: NotRequired[str]
    reason: NotRequired[str]
    tokens: NotRequired[int]
    usd: NotRequired[float]
    tool_calls: NotRequired[int]
    caps: NotRequired[dict[str, Any]]
    stage: NotRequired[str]


# EventType → its payload shape. The single map export + validation read from.
EVENT_PAYLOADS: dict[EventType, type] = {
    "phase": PhaseData,
    "tool_call": ToolCallData,
    "tool_result": ToolResultData,
    "finding": FindingData,
    "cost": CostData,
    "refusal": RefusalData,
    "halt": HaltData,
}


def make_event(type: EventType, data: dict[str, Any]) -> Event:
    """Stamp an envelope: ISO-8601 UTC ts + type + data. Shape only, no IO."""
    return Event(
        ts=datetime.now(UTC).isoformat(),
        type=type,
        data=data,
    )


def validate_event(event: Event) -> None:
    """Fail-closed conformance check against the frozen payload shapes.

    Raises ValueError if the type is unknown or a required payload key is missing.
    Cheap enough to run over an emitted stream in tests (the drift guard) or as an
    assertion in a consumer; it does not police optional keys, only the invariants.
    """
    etype = event.get("type")
    if etype not in EVENT_PAYLOADS:
        raise ValueError(f"unknown event type: {etype!r}")
    data = event.get("data")
    if not isinstance(data, dict):
        raise ValueError(  # noqa: TRY004  contract validation: ValueError is the seam signal, not TypeError
            f"event {etype}: data must be a mapping, got {type(data).__name__}"
        )
    required = EVENT_PAYLOADS[etype].__required_keys__  # type: ignore[attr-defined]
    missing = required - data.keys()
    if missing:
        raise ValueError(f"event {etype}: missing required key(s) {sorted(missing)}")
