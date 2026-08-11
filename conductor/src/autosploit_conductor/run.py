"""Run orchestrator — wires steps 1..7, returns RunResult (docs/conductor.md §7 run.py).

The one place that owns the whole engagement: context → provision → config_gen →
launch → result, with teardown in `try/finally` and the run record written last.
The api_key is resolved HERE from the environment (`OPENROUTER_API_KEY`) — the
orchestrator is the only component that touches it, and it only ever hands it to
the harness subprocess env, never to the provisioner, never to disk (§2 trust
boundary, §8 key hygiene).

Outcome contract: a failed provision or a failed harness run is a *recorded*
outcome, not an exception — `run` always returns `(result, record_path)`, with
the record written on every terminal path (§8) so the control plane can
distinguish a halted run from a failed one via the record, not the exit code.
Only genuine internal errors (bad engagement id, missing scope, a harness that
cannot be started) raise.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from pathlib import Path

from autosploit_conductor.config_gen import write_run_config
from autosploit_conductor.context import EngagementContext, make_context
from autosploit_conductor.launch import launch_harness
from autosploit_conductor.provision import (
    Handoff,
    HandoffParseError,
    ProvisionFailed,
    invoke_provision,
)
from autosploit_conductor.record import ProvisionOutcome, write_record
from autosploit_conductor.result import RunResult, map_result
from autosploit_conductor.teardown import teardown_run

# The one env var the conductor is trusted with (§2, §8).
_API_KEY_ENV = "OPENROUTER_API_KEY"


def run(
    repo_ref: str,
    engagement_id: str | None = None,
    out_dir: Path | str = ".",
    api_key: str | None = None,
    *,
    provision_cmd: Sequence[str] = ("provision",),
    harness_cmd: Sequence[str] = ("autosploit-harness",),
    timeout_s: float | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[RunResult, Path | None]:
    """Run one engagement end to end and tear everything down (C5).

    `provision_cmd`/`harness_cmd`/`env` are seams for the C5 integration tests
    (fake provisioner + fake harness, no Docker). `api_key` defaults to
    `OPENROUTER_API_KEY` from the environment. Returns `(result, record_path)`.

    `record_path` is None only on the genuinely-broken paths — a bad engagement
    id (context raises) or a record write that failed after teardown removed the
    out-dir. A failed provision (provisioner exited non-zero — it already tore
    itself down, §8) or a failed harness run are recorded outcomes, not
    exceptions: the record is written before teardown runs.
    """
    if api_key is None:
        env_base = dict(os.environ) if env is None else dict(env)
        api_key = env_base.get(_API_KEY_ENV, "")

    ctx = make_context(repo_ref, engagement_id, out_dir, timeout_s=timeout_s or 3600.0)

    provision: ProvisionOutcome = ProvisionOutcome(ok=False, error="provision never attempted")
    harness_result: RunResult | None = None
    record_path: Path | None = None
    started_at = _now_iso()

    try:
        try:
            handoff = invoke_provision(
                repo_ref,
                ctx,
                provision_cmd=provision_cmd,
                timeout_s=timeout_s,
                env=env,
            )
            provision = ProvisionOutcome(ok=True, exit_code=0)
        except (ProvisionFailed, HandoffParseError) as exc:
            # The provisioner already cleaned up after itself (§8) — record the
            # failure and skip the harness entirely. The target never came up, so
            # this is a failed run, not a crash.
            provision = ProvisionOutcome(ok=False, error=str(exc))
            harness_result = RunResult(
                status="failed",
                report_path=None,
                halt_reason=str(exc),
                exit_code=1,
            )
        else:
            harness_result = _launch(ctx, handoff, harness_cmd, api_key, timeout_s, env)
    finally:
        # Teardown always runs (atexit + signals already registered nothing here —
        # we call it directly so the out-dir is removed even on a raised error).
        try:
            teardown_run(ctx)
        finally:
            # The record is written after teardown (so a teardown failure can never
            # mask it) but INTO the out-dir, which teardown just removed — so it is
            # re-created here. Zero residue is violated by design: the record is the
            # Phase A stand-in for the control-plane Postgres row and is the ONE
            # file allowed to survive the engagement (§4 [7]).
            record_path = _write_record_after_teardown(ctx, provision, harness_result, started_at)

    return harness_result, record_path


def _write_record_after_teardown(
    ctx: EngagementContext,
    provision: ProvisionOutcome,
    result: RunResult | None,
    started_at: str,
) -> Path | None:
    """Write conductor.json after the out-dir was removed (re-creating it). None on failure."""
    try:
        ctx.out_dir.mkdir(parents=True, exist_ok=True)
        return write_record(
            ctx,
            provision,
            result,
            started_at=started_at,
            finished_at=_now_iso(),
        )
    except OSError:
        return None


def _launch(
    ctx: EngagementContext,
    handoff: Handoff,
    harness_cmd: Sequence[str],
    api_key: str,
    timeout_s: float | None,
    env: Mapping[str, str] | None,
) -> RunResult:
    """Generate the run.toml, launch the harness, and map its exit to a RunResult.

    Raises `ConfigGenError` (missing scope — fail closed, §8) or `LaunchError`
    (harness cannot be started) — both are internal failures the CLI surfaces.
    """
    run_toml = write_run_config(ctx, handoff.scope_path)
    outcome = launch_harness(
        handoff,
        ctx,
        run_toml,
        api_key,
        harness_cmd=harness_cmd,
        timeout_s=timeout_s,
        env=env,
    )
    return map_result(outcome, ctx)


def _now_iso() -> str:
    """ISO-8601 UTC timestamp, mirroring record._now_iso (§4 [7])."""
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
