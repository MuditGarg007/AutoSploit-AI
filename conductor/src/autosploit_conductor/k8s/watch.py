"""Watcher — poll the attacker Pod to completion, map to RunResult (orchestration.md §6 [4]).

M6 step 3. The Phase B replacement for Phase A's `proc.wait(timeout)` (launch.py):
the attacker runs on a cluster node, so there is no process handle to wait on —
we poll the Pod's `status.phase` until it is terminal (`Succeeded`/`Failed`) or a
wall-clock timeout trips, then map that to the SAME `RunResult`
(`complete`/`partial`/`failed`) the Phase A `result.map_result` produces, so the
record and CLI downstream are untouched.

`now`/`sleep` are injected so the poll loop is tested against a scripted phase
sequence with no real waiting — the same seam philosophy as the rest of Phase B.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from autosploit_conductor.launch import EXIT_PARTIAL
from autosploit_conductor.result import RunResult

# Pod phases that mean the run is over (kubernetes Pod lifecycle). Everything
# else — Pending, Running, Unknown, or an unreadable None — means "keep polling".
TERMINAL_PHASES = frozenset({"Succeeded", "Failed"})

_DEFAULT_POLL_INTERVAL_S = 2.0


class PodStatusSource(Protocol):
    """The read surface the watcher needs — satisfied by `EngagementCluster`."""

    def pod_phase(self, name: str) -> str | None: ...
    def container_exit_code(self, name: str) -> int | None: ...


@dataclass(frozen=True, slots=True)
class PodOutcome:
    """What the watcher observed: the terminal phase (or last seen) + timeout flag."""

    phase: str | None
    exit_code: int | None = None
    timed_out: bool = False


def watch_pod(
    cluster: PodStatusSource,
    name: str,
    *,
    timeout_s: float,
    poll_interval_s: float = _DEFAULT_POLL_INTERVAL_S,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> PodOutcome:
    """Poll `name` until it reaches a terminal phase or `timeout_s` elapses.

    Returns a `PodOutcome`: on a terminal phase, the phase plus the container exit
    code (needed only to split partial from failed on a `Failed` Pod); on timeout,
    the last phase seen with `timed_out=True`. Always polls at least once.
    """
    deadline = now() + timeout_s
    phase = cluster.pod_phase(name)
    while True:
        if phase in TERMINAL_PHASES:
            return PodOutcome(phase=phase, exit_code=cluster.container_exit_code(name))
        if now() >= deadline:
            return PodOutcome(phase=phase, exit_code=None, timed_out=True)
        sleep(poll_interval_s)
        phase = cluster.pod_phase(name)


def wait_pod_running(
    cluster: PodStatusSource,
    name: str,
    *,
    timeout_s: float,
    poll_interval_s: float = _DEFAULT_POLL_INTERVAL_S,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Poll `name` until it is `Running`, returning True; False on Failed/timeout.

    Unlike `watch_pod` (which waits for a terminal phase), this waits for a
    long-lived Pod — the M8 registry — to come up so a client can use it, then
    returns. A `Failed`/`Succeeded` phase (the registry died) or a timeout is a
    False so the caller can treat it as a failed provision. Always polls at least
    once."""
    deadline = now() + timeout_s
    while True:
        phase = cluster.pod_phase(name)
        if phase == "Running":
            return True
        if phase in TERMINAL_PHASES:
            return False
        if now() >= deadline:
            return False
        sleep(poll_interval_s)


def map_pod_result(outcome: PodOutcome) -> RunResult:
    """Map a `PodOutcome` to the shared `RunResult` (Seam B semantics).

    - timeout             → partial, halt_reason "timeout" (matches Phase A).
    - phase Succeeded     → complete (a Succeeded Pod is always exit 0).
    - phase Failed, exit 2 → partial (a clean harness halt, Seam B §3.2).
    - anything else       → failed.

    `report_path` is None here: the report is produced inside the attacker Pod,
    not on the conductor's disk, so the orchestrator collects it separately (from
    the Pod logs); the lifecycle status is decided entirely by phase + exit code.
    """
    if outcome.timed_out:
        return RunResult(
            status="partial",
            report_path=None,
            halt_reason="timeout",
            exit_code=outcome.exit_code,
        )
    if outcome.phase == "Succeeded":
        return RunResult(status="complete", report_path=None, exit_code=0)
    if outcome.exit_code == EXIT_PARTIAL:
        return RunResult(
            status="partial",
            report_path=None,
            halt_reason=None,
            exit_code=EXIT_PARTIAL,
        )
    return RunResult(status="failed", report_path=None, exit_code=outcome.exit_code)
