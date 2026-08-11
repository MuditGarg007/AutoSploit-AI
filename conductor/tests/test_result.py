"""C3 tests — exit-code → RunResult mapping (docs/conductor.md C3).

Pure, no subprocess: `map_result` reads the exit code and the report on disk
and produces the lifecycle outcome. 0 → complete, 2 → partial (with the halt
reason read from the report), timeout → partial(timeout), any other non-zero →
failed. `report_path` is None whenever the report file is absent.
"""

from __future__ import annotations

import json
from pathlib import Path

from autosploit_conductor.context import make_context
from autosploit_conductor.launch import EXIT_COMPLETE, EXIT_PARTIAL, HarnessOutcome
from autosploit_conductor.result import map_result


def _ctx(tmp_path: Path):
    return make_context("https://github.com/acme/juice-shop", "eng-1", out_dir=tmp_path)


def _write_report(ctx, *, halt_reason: str | None = None) -> Path:
    report = ctx.out_dir / "runs" / "report.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        json.dumps({"completed": halt_reason is None, "halt_reason": halt_reason}),
        encoding="utf-8",
    )
    return report


def test_exit_0_complete_with_report(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    report = _write_report(ctx)

    result = map_result(HarnessOutcome(exit_code=EXIT_COMPLETE), ctx)

    assert result.status == "complete"
    assert result.report_path == report
    assert result.exit_code == EXIT_COMPLETE
    assert result.halt_reason is None


def test_exit_0_complete_timestamped_subdir(tmp_path: Path) -> None:
    """Real-harness layout: <out>/runs/<timestamp>/report.json (driver/run.py)."""
    ctx = _ctx(tmp_path)
    run_dir = ctx.out_dir / "runs" / "20260810T120000Z"
    run_dir.mkdir(parents=True, exist_ok=True)
    report = run_dir / "report.json"
    report.write_text(json.dumps({"completed": True}), encoding="utf-8")

    result = map_result(HarnessOutcome(exit_code=EXIT_COMPLETE), ctx)

    assert result.status == "complete"
    assert result.report_path == report
    assert result.halt_reason is None


def test_exit_0_picks_newest_timestamped_subdir(tmp_path: Path) -> None:
    """Multiple timestamped runs → the newest (lexically last) is the one."""
    ctx = _ctx(tmp_path)
    for name in ("20260810T110000Z", "20260810T120000Z"):
        run_dir = ctx.out_dir / "runs" / name
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "report.json").write_text(
            json.dumps({"completed": True, "run": name}), encoding="utf-8"
        )

    result = map_result(HarnessOutcome(exit_code=EXIT_COMPLETE), ctx)

    assert result.report_path is not None
    assert result.report_path.name == "report.json"
    assert result.report_path.parent.name == "20260810T120000Z"


def test_exit_0_no_report_path(tmp_path: Path) -> None:
    """Exit 0 but no report on disk → report_path is None (driven by disk state)."""
    ctx = _ctx(tmp_path)

    result = map_result(HarnessOutcome(exit_code=EXIT_COMPLETE), ctx)

    assert result.status == "complete"
    assert result.report_path is None


def test_exit_2_partial_with_halt_reason(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    _write_report(ctx, halt_reason="budget.max_tool_calls")

    result = map_result(HarnessOutcome(exit_code=EXIT_PARTIAL), ctx)

    assert result.status == "partial"
    assert result.halt_reason == "budget.max_tool_calls"
    assert result.exit_code == EXIT_PARTIAL
    assert result.report_path is not None


def test_exit_2_partial_without_report(tmp_path: Path) -> None:
    """Exit 2 but no report → partial with no halt reason and no report path."""
    ctx = _ctx(tmp_path)

    result = map_result(HarnessOutcome(exit_code=EXIT_PARTIAL), ctx)

    assert result.status == "partial"
    assert result.halt_reason is None
    assert result.report_path is None


def test_exit_2_corrupt_report_no_halt_reason(tmp_path: Path) -> None:
    """A corrupt report must not crash the mapping — halt reason is dropped."""
    ctx = _ctx(tmp_path)
    report = ctx.out_dir / "runs" / "report.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("not json", encoding="utf-8")

    result = map_result(HarnessOutcome(exit_code=EXIT_PARTIAL), ctx)

    assert result.status == "partial"
    assert result.halt_reason is None
    assert result.report_path == report


def test_timeout_partial_timeout(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)

    result = map_result(HarnessOutcome(exit_code=-1, timed_out=True), ctx)

    assert result.status == "partial"
    assert result.halt_reason == "timeout"


def test_other_nonzero_failed(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)

    result = map_result(HarnessOutcome(exit_code=5), ctx)

    assert result.status == "failed"
    assert result.report_path is None
    assert result.exit_code == 5
