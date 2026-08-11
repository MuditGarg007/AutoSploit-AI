"""Watcher / result — exit code to RunResult (complete/partial/failed) (docs/conductor.md §7 [5]).

Maps the harness's exit code to a lifecycle outcome (Seam B §3.2):
- exit 0  → complete  — full report at <out>/runs/report.json.
- exit 2  → partial   — a halted run that still produced a report; treat as
  success for the conductor's lifecycle (teardown + record the halt reason).
- any other non-zero → failed — the run produced no usable report.

`report_path` is None unless the report file actually exists — the mapping is
driven by what's on disk, not just the exit code.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from autosploit_conductor.context import EngagementContext
from autosploit_conductor.launch import EXIT_COMPLETE, EXIT_PARTIAL, HarnessOutcome

ReportStatus = Literal["complete", "partial", "failed"]


@dataclass(frozen=True, slots=True)
class RunResult:
    """Lifecycle outcome of a harness run (docs/conductor.md §4 [5])."""

    status: ReportStatus
    report_path: Path | None
    halt_reason: str | None = None
    exit_code: int | None = None


def _report_path(ctx: EngagementContext) -> Path | None:
    """Locate the report the harness wrote under <out>/runs, or None.

    The real harness (driver/run.py) writes each run into a timestamped subdir:
    `<out>/runs/<YYYYmmddTHHMMSSZ>/report.json`. The C5 fakes write directly to
    `<out>/runs/report.json`. Both layouts are honored — the direct one first
    (the deterministic fake path), then the newest timestamped subdir.
    """
    runs_dir = ctx.out_dir / "runs"
    direct = runs_dir / "report.json"
    if direct.exists():
        return direct

    reports = sorted(runs_dir.glob("*/report.json"))
    if reports:
        # The harness stamps subdirs with UTC `%Y%m%dT%H%M%SZ`, so lexical sort
        # == chronological; the last one is the run that just finished.
        return reports[-1]

    return None


def _read_halt_reason(report_path: Path) -> str | None:
    """Pull `halt_reason` from the report if present (the run record of a halt)."""
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    reason = data.get("halt_reason") if isinstance(data, dict) else None
    return reason if isinstance(reason, str) else None


def map_result(outcome: HarnessOutcome, ctx: EngagementContext) -> RunResult:
    """Map a launcher outcome to a RunResult using the exit code + disk state."""
    report = _report_path(ctx)

    if outcome.exit_code == EXIT_COMPLETE:
        return RunResult(
            status="complete",
            report_path=report,
            exit_code=outcome.exit_code,
        )

    if outcome.exit_code == EXIT_PARTIAL:
        return RunResult(
            status="partial",
            report_path=report,
            halt_reason=_read_halt_reason(report) if report is not None else None,
            exit_code=outcome.exit_code,
        )

    if outcome.timed_out:
        return RunResult(
            status="partial",
            report_path=report,
            halt_reason="timeout",
            exit_code=outcome.exit_code,
        )

    return RunResult(
        status="failed",
        report_path=report,
        exit_code=outcome.exit_code,
    )
