"""loop_guard — repeat-call rejection (docs/harness.md §6.1.3, §5).

Reads the ledger's attempt log; if the agent emits a call identical to one
already tried, reject it and tell the agent to try something else. Doubles as the
runaway-loop guard, independent of the token budget. Decision logic only — the
attempt record itself lives in ledger/attempt_log.py.
"""

from __future__ import annotations

from typing import Any

from autosploit_harness.ledger.attempt_log import AttemptLog


def is_repeat(name: str, args: dict[str, Any], attempts: AttemptLog) -> str | None:
    """Return a deny reason if this exact call was already tried, else None.

    Identical = same tool name + same args (order-independent fingerprint). The
    gate turns the reason into a corrective tool_result so the agent varies its
    approach instead of spinning on the same probe (§6.1.3).
    """
    if attempts.seen(name, args):
        return (
            f"BLOCKED: {name} with these exact arguments was already attempted — "
            f"check the attempt log and try a different approach."
        )
    return None
