"""Run record — conductor.json (engagement id, statuses, report path, timestamps) (docs/conductor.md §7 [7]).

The Phase A stand-in for the future control-plane Postgres row (§4 [7]): written
on EVERY terminal path — complete, partial, failed(provision), failed(harness) —
so the control plane can distinguish a halted run from a failed one via the
record, not the exit code (§8, C5). No key, ever (§8).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from autosploit_conductor.context import EngagementContext
from autosploit_conductor.result import RunResult


@dataclass(frozen=True, slots=True)
class RunRecord:
    """One engagement's run record — the conductor.json payload (docs/conductor.md §4 [7]).

    `provision` carries the provision outcome (ok / exit / error); `harness` is
    None when the harness never ran (a failed provision or a bad handoff).
    """

    engagement_id: str
    repo_ref: str
    started_at: str
    finished_at: str
    provision_ok: bool
    provision_exit: int | None
    provision_error: str | None = None
    harness: RunResult | None = None
    status: str | None = None
    report_path: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProvisionOutcome:
    """What happened to the provision step (docs/conductor.md §4 [2])."""

    ok: bool
    exit_code: int | None = None
    error: str | None = None


def write_record(
    ctx: EngagementContext,
    provision: ProvisionOutcome,
    result: RunResult | None,
    *,
    started_at: str | None = None,
    finished_at: str | None = None,
    extra: dict[str, Any] | None = None,
) -> Path:
    """Write `conductor.json` into the engagement out-dir and return its path.

    Written on every terminal path (§8) — teardown removes the out-dir, so the
    record is only useful before that; the future control plane reads it there.
    """
    now_iso = _now_iso()
    record = RunRecord(
        engagement_id=ctx.engagement_id,
        repo_ref=ctx.repo_ref,
        started_at=started_at or now_iso,
        finished_at=finished_at or now_iso,
        provision_ok=provision.ok,
        provision_exit=provision.exit_code,
        provision_error=provision.error,
        harness=result if provision.ok else None,
        status=_run_status(result) if provision.ok else None,
        report_path=_report_path_as_str(result),
        extra=extra or {},
    )

    record_path = ctx.out_dir / "conductor.json"
    record_path.write_text(
        json.dumps(_to_dict(record), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return record_path


def _now_iso() -> str:
    """ISO-8601 UTC timestamp with 'Z', the control-plane-friendly form (§4 [7])."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run_status(result: RunResult | None) -> str | None:
    """Surface the lifecycle outcome — None when the harness never started."""
    return result.status if result is not None else None


def _report_path_as_str(result: RunResult | None) -> str | None:
    """The report path as a string — None when no report exists."""
    if result is None or result.report_path is None:
        return None
    return str(result.report_path)


def _to_dict(record: RunRecord) -> dict[str, Any]:
    """Flatten the record to plain JSON values (no Paths, no dataclasses)."""
    out: dict[str, Any] = {
        "engagement_id": record.engagement_id,
        "repo_ref": record.repo_ref,
        "started_at": record.started_at,
        "finished_at": record.finished_at,
        "provision": {
            "ok": record.provision_ok,
            "exit_code": record.provision_exit,
            "error": record.provision_error,
        },
        "harness": None,
        "status": record.status,
        "report_path": record.report_path,
    }
    if record.harness is not None:
        out["harness"] = {
            "status": record.harness.status,
            "report_path": (
                str(record.harness.report_path)
                if record.harness.report_path is not None
                else None
            ),
            "halt_reason": record.harness.halt_reason,
            "exit_code": record.harness.exit_code,
        }
    if record.extra:
        out["extra"] = _sanitize_extra(record.extra)
    return out


# Keys that can never appear in a record — anything named like a credential is
# refused outright so a slip can't leak a secret into conductor.json (§8).
_FORBIDDEN_KEYS = frozenset(
    {"api_key", "apikey", "api-key", "token", "secret", "password", "key"}
)


def _sanitize_extra(extra: dict[str, Any]) -> dict[str, Any]:
    """Drop any extra entries whose key looks like a credential (§8, key hygiene)."""
    return {k: v for k, v in extra.items() if k.lower() not in _FORBIDDEN_KEYS}
