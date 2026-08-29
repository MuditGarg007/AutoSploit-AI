"""truncate — output capping + overflow handling (docs/harness.md §4, §5).

Tool outputs (nmap scans, big HTTP bodies) can blow the context window. Cap each
result; on overflow, write the full output to the ledger (addressable by id) and
hand the agent a preview + file path it can `run_shell cat` if it needs the rest.
Shared by every adapter so truncation policy lives in one place, not per-tool.

Step 3 (§9): the cap runs in the TOOL NODE, not the adapters — the adapter returns
full output, the tool node writes the full text to the ledger (addressable by call
id) and hands the transcript this capped head + the on-disk path. So the ledger
holds full-before-truncate, and the context stays bounded.
"""

from __future__ import annotations

# Default per-stream cap. Generous — DeepSeek V4 is 1M ctx (§5) — but bounded so a
# runaway scan can't blow the window in one shot.
DEFAULT_CAP = 16_000


def truncate(text: str, cap: int = DEFAULT_CAP) -> tuple[str, bool]:
    """Return (possibly-truncated text, truncated?). Keeps the head, marks the cut."""
    if len(text) <= cap:
        return text, False
    head = text[:cap]
    return head + f"\n…[truncated {len(text) - cap} chars]", True
