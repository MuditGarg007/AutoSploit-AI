"""fallback — availability + refusal handling (docs/harness.md §6, §6.1.4).

Two distinct failure modes, handled differently:

  - AVAILABILITY (provider outage / rate limit) — handled OpenRouter-native. The
    client sends `extra_body={"models": [primary, *fallbacks]}` (see model_list
    below); OpenRouter transparently routes the same request to the next model on
    an upstream error. Zero client-side orchestration — a config line, not a
    re-drive loop.

  - REFUSAL (a *successful* completion that declines the task) — some upstreams
    apply their own moderation. The models array does NOT fall over on this: the
    call "succeeded". So it is caught client-side (is_refusal below), surfaced as
    a `refusal` event (§7), and the run stops clean rather than pretending the
    empty turn was progress. Far lower probability than Claude on offensive work,
    but not zero. A full model-by-model refusal re-drive is a later addition; step
    3 detects + emits, which is what the event stream and eval rig need.
"""

from __future__ import annotations

from typing import Any

# Short, lowercased markers that a completion is a policy refusal, not an answer.
# Kept deliberately tight — false positives here would abort a live run — so it
# only fires on canonical refusal openers plus an outright empty completion.
_REFUSAL_MARKERS = (
    "i can't help with that",
    "i cannot help with that",
    "i can't assist with that",
    "i cannot assist with that",
    "i'm not able to help with that",
    "i am not able to help with that",
    "i won't help with that",
    "i will not help with that",
)


def model_list(primary: str, fallbacks: tuple[str, ...]) -> list[str]:
    """OpenRouter `models` array: primary first, then de-duplicated fallbacks.

    Sent as extra_body so OpenRouter handles availability fallback natively (§6).
    """
    ordered = [primary]
    for m in fallbacks:
        if m and m not in ordered:
            ordered.append(m)
    return ordered


def is_refusal(response: Any) -> bool:
    """True if this completion looks like a policy refusal or an empty turn.

    A refusal is a completion with no tool calls whose text opens with a canonical
    refusal marker, or a turn that returned neither content nor any tool call at
    all. Conservative on purpose (§6.1.4) — a normal prose turn that just lacks a
    tool call is the nudge path (§6.1.2), not a refusal.
    """
    tool_calls = getattr(response, "tool_calls", None) or []
    invalid = getattr(response, "invalid_tool_calls", None) or []
    if tool_calls or invalid:
        return False

    content = getattr(response, "content", "") or ""
    text = content if isinstance(content, str) else str(content)
    stripped = text.strip()
    if not stripped:
        return True
    head = stripped[:120].lower()
    return any(marker in head for marker in _REFUSAL_MARKERS)
