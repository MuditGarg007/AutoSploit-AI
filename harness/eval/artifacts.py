"""artifacts — load one run's on-disk artifacts for scoring (docs/harness.md §8).

Scoring reads the SAME artifacts the dashboard would (§8): the JSONL event
stream, the report the driver wrote, and the ledger findings. This module is the
single loader both score.py and metrics.py read through, so a run directory has
one shape the whole eval rig agrees on.

A run directory (driver.run writes it, driver/run.py) holds:
    events.jsonl     the frozen event stream (§7) — the metrics source
    report.json      the driver's Report.to_dict() — budget + step counts
    findings.jsonl   the ledger's scored artifact (§5) — the score source
    outputs/<id>.txt full tool outputs (not needed for scoring, present for repro)

Lives OUTSIDE the package (eval/, not src/): the eval rig CONSUMES the driver's
output, it doesn't ship inside the harness (§8, score.py).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class RunArtifacts:
    """Everything scoring needs from one run directory, loaded once.

    `events` is the frozen JSONL stream (§7); `report` is the driver's report
    dict; `findings` is the ledger's scored list (§5). `run_dir` is kept so a
    consumer can reach the raw tool outputs for manual repro.
    """

    run_dir: Path
    events: list[dict[str, Any]]
    report: dict[str, Any]
    findings: list[dict[str, Any]] = field(default_factory=list)

    def events_of(self, type: str) -> list[dict[str, Any]]:
        """Every event of one type, in stream order."""
        return [e for e in self.events if e.get("type") == type]

    def wall_time_seconds(self) -> float | None:
        """Elapsed wall time from the first to the last event ts (§8 metric).

        None when the stream has fewer than two timestamped events. Reads the
        ISO-8601 ts the emitter stamps (contracts/events.make_event)."""
        stamps = [e.get("ts") for e in self.events if e.get("ts")]
        if len(stamps) < 2:
            return None
        try:
            start = datetime.fromisoformat(stamps[0])
            end = datetime.fromisoformat(stamps[-1])
        except ValueError:
            return None
        return (end - start).total_seconds()


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Parse a JSONL file into a list of dicts; missing file → []."""
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def load_run(run_dir: Path) -> RunArtifacts:
    """Load a run directory into RunArtifacts. Fail-closed on a missing dir.

    events.jsonl / findings.jsonl absent → empty lists (a run that produced
    neither is a legitimate — if poor — result, not a load error). report.json
    absent → empty dict.
    """
    run_dir = Path(run_dir)
    if not run_dir.is_dir():
        raise FileNotFoundError(f"run directory not found: {run_dir}")

    report_path = run_dir / "report.json"
    report: dict[str, Any] = {}
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))

    return RunArtifacts(
        run_dir=run_dir,
        events=_read_jsonl(run_dir / "events.jsonl"),
        report=report,
        findings=_read_jsonl(run_dir / "findings.jsonl"),
    )
