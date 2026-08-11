"""C4 tests — the conductor.json run record (docs/conductor.md C4).

Pure, no subprocess: `write_record` is the Phase A stand-in for the future
control-plane Postgres row (§4 [7]) — written on every terminal path with the
engagement id, repo ref, provision/harness statuses, report path, and ISO
timestamps. No key string may ever appear in the record (§8).
"""

from __future__ import annotations

import json
from pathlib import Path

from autosploit_conductor.context import make_context
from autosploit_conductor.launch import EXIT_COMPLETE, EXIT_PARTIAL, HarnessOutcome
from autosploit_conductor.record import ProvisionOutcome, write_record
from autosploit_conductor.result import RunResult, map_result


def _ctx(tmp_path: Path):
    return make_context("https://github.com/acme/juice-shop", "eng-1", out_dir=tmp_path)


def _read_record(record_path: Path) -> dict:
    return json.loads(record_path.read_text(encoding="utf-8"))


def test_record_written_on_complete(tmp_path: Path) -> None:
    """A full run → record with provision ok + complete harness status."""
    ctx = _ctx(tmp_path)
    (ctx.out_dir / "runs").mkdir(parents=True, exist_ok=True)
    (ctx.out_dir / "runs" / "report.json").write_text(
        json.dumps({"completed": True}), encoding="utf-8"
    )
    result = map_result(HarnessOutcome(exit_code=EXIT_COMPLETE), ctx)

    record_path = write_record(ctx, ProvisionOutcome(ok=True, exit_code=0), result)

    assert record_path == ctx.out_dir / "conductor.json"
    data = _read_record(record_path)
    assert data["engagement_id"] == "eng-1"
    assert data["repo_ref"] == "https://github.com/acme/juice-shop"
    assert data["provision"] == {"ok": True, "exit_code": 0, "error": None}
    assert data["harness"]["status"] == "complete"
    assert data["harness"]["exit_code"] == 0
    assert data["harness"]["report_path"] is not None
    assert data["harness"]["halt_reason"] is None
    assert data["status"] == "complete"


def test_record_harness_never_started(tmp_path: Path) -> None:
    """failed(provision) → harness None; the record still exists (every terminal path)."""
    ctx = _ctx(tmp_path)

    record_path = write_record(
        ctx,
        ProvisionOutcome(ok=False, error="provisioner exited 1: no Docker daemon"),
        result=None,
    )

    data = _read_record(record_path)
    assert data["provision"]["ok"] is False
    assert data["provision"]["error"] == "provisioner exited 1: no Docker daemon"
    assert data["harness"] is None
    assert data["status"] is None


def test_record_partial_run(tmp_path: Path) -> None:
    """A halted run → partial status with the halt reason preserved."""
    ctx = _ctx(tmp_path)
    (ctx.out_dir / "runs").mkdir(parents=True, exist_ok=True)
    (ctx.out_dir / "runs" / "report.json").write_text(
        json.dumps({"completed": False, "halt_reason": "budget.max_tool_calls"}),
        encoding="utf-8",
    )
    result = map_result(HarnessOutcome(exit_code=EXIT_PARTIAL), ctx)

    record_path = write_record(ctx, ProvisionOutcome(ok=True, exit_code=0), result)

    data = _read_record(record_path)
    assert data["status"] == "partial"
    assert data["harness"]["status"] == "partial"
    assert data["harness"]["halt_reason"] == "budget.max_tool_calls"


def test_record_contains_no_key_string(tmp_path: Path) -> None:
    """§8 key hygiene: no key may ever reach the record."""
    ctx = _ctx(tmp_path)
    result = RunResult(status="failed", report_path=None, exit_code=5)

    record_path = write_record(
        ctx,
        ProvisionOutcome(ok=True, exit_code=0),
        result,
        extra={"api_key": "sk-or-test-key-1234567890"},
    )

    assert "sk-or-test-key-1234567890" not in record_path.read_text(encoding="utf-8")


def test_record_timestamps_iso(tmp_path: Path) -> None:
    """ISO-8601 timestamps (§4 [7]) — parseable and timezone-aware."""
    from datetime import datetime

    ctx = _ctx(tmp_path)
    record_path = write_record(ctx, ProvisionOutcome(ok=True, exit_code=0), None)

    data = _read_record(record_path)
    for key in ("started_at", "finished_at"):
        # ISO-8601 UTC (§4 [7]) — fromisoformat handles the trailing Z as UTC.
        parsed = datetime.fromisoformat(data[key])
        assert parsed.tzinfo is not None
