"""attempt_log — what-was-tried record (docs/harness.md §5, §6.1.3).

Records each attempted tool call + its args + a short result summary. Two
consumers:
  - the agent's "what have I not tried" reasoning (fed back into context).
  - interceptor/loop_guard.py, which reads this to reject identical repeat calls.

The durable record; loop_guard.py holds the decision logic, this holds the data.
Append-only JSONL on disk (attempts.jsonl), one object per attempted call. A
canonical fingerprint (name + normalized args) is stored on each row so the
loop guard can test set-membership without re-parsing args.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def fingerprint(name: str, args: dict[str, Any]) -> str:
    """Canonical, order-independent key for a tool call: name + sorted args.

    Two calls with the same name and same arguments (any dict ordering) collapse
    to one fingerprint — the unit the loop guard dedupes on (§6.1.3).
    """
    canon = json.dumps(args or {}, sort_keys=True, ensure_ascii=False, default=str)
    return f"{name}:{canon}"


class AttemptLog:
    """Append-only record of attempted tool calls, backed by attempts.jsonl."""

    def __init__(self, path: Path) -> None:
        self._path = path
        # In-memory fingerprint set for O(1) repeat checks within a run. Seeded
        # from disk so a resumed run (or a re-opened ledger) still dedupes.
        self._seen: set[str] = set()
        if path.exists():
            for raw in path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line:
                    continue
                try:
                    self._seen.add(json.loads(line)["fp"])
                except (json.JSONDecodeError, KeyError):
                    continue

    def record(self, name: str, args: dict[str, Any], result: str = "") -> None:
        """Append an attempt (name + args + short result) and remember its fp."""
        fp = fingerprint(name, args)
        self._seen.add(fp)
        row = {"fp": fp, "name": name, "args": args or {}, "result": result[:500]}
        with self._path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")

    def seen(self, name: str, args: dict[str, Any]) -> bool:
        """True iff a call with this exact name + args was already attempted."""
        return fingerprint(name, args) in self._seen

    def all(self) -> list[dict[str, Any]]:
        """Every recorded attempt, in order — for the report / agent recap."""
        if not self._path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for raw in self._path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line:
                rows.append(json.loads(line))
        return rows
