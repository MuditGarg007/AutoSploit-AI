"""emitter — JSONL event writer (docs/harness.md §7).

One append-only sink the whole harness emits through: phase, tool_call,
tool_result, finding, cost, refusal, halt (§7). Writes JSONL to stdout and/or a
run file. The driver holds the emitter and passes it to nodes/tools so every
event goes through one place, in schema order (contracts/events.py). Swapping to
SSE later changes this sink, not any caller.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Self, TextIO

from autosploit_harness.contracts.events import Event, EventType, make_event


class JsonlEmitter:
    """Append-only JSONL sink. stdout and/or a run file. One per run.

    Standalone stand-in for the SSE gateway (§7) — same schema, different sink.
    """

    def __init__(self, path: Path | None = None, stdout: bool = True) -> None:
        self._stdout: TextIO | None = sys.stdout if stdout else None
        self._file: TextIO | None = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._file = path.open("a", encoding="utf-8")
        self.events: list[Event] = []  # in-memory mirror; report/tests read this

    def emit(self, type: EventType, data: dict[str, Any]) -> Event:
        """Stamp an envelope (contracts.make_event) and write it to every sink."""
        event = make_event(type, data)
        self.events.append(event)
        line = json.dumps(event, ensure_ascii=False)
        # Tool output carries arbitrary bytes (Juice Shop bodies include non-Latin-1
        # chars); a narrow console encoding (Windows cp1252) would raise mid-run.
        # The file is utf-8, so it keeps full fidelity; the console mirror falls
        # back to escaped ascii rather than crashing the engagement.
        if self._stdout is not None:
            self._safe_write(self._stdout, line)
        if self._file is not None:
            self._safe_write(self._file, line)
        return event

    @staticmethod
    def _safe_write(stream: TextIO, line: str) -> None:
        try:
            stream.write(line + "\n")
        except UnicodeEncodeError:
            enc = getattr(stream, "encoding", None) or "utf-8"
            safe = (line + "\n").encode(enc, "backslashreplace").decode(enc)
            stream.write(safe)
        stream.flush()

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
