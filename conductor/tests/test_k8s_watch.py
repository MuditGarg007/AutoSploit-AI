"""Tests for the watcher (M6 step 3).

A scripted fake cluster feeds a phase sequence; injected `now`/`sleep` make the
poll loop run instantly. Proves the terminal/timeout logic and the Pod->RunResult
mapping (complete/partial/failed), matching Seam B semantics.
"""

from __future__ import annotations

import pytest

from autosploit_conductor.k8s.watch import (
    PodOutcome,
    map_pod_result,
    wait_pod_running,
    watch_pod,
)


class ScriptedCluster:
    """Yields a preset sequence of phases; last phase repeats once exhausted."""

    def __init__(self, phases: list[str | None], exit_code: int | None = 0) -> None:
        self._phases = phases
        self._i = 0
        self._exit_code = exit_code

    def pod_phase(self, name: str) -> str | None:
        phase = self._phases[min(self._i, len(self._phases) - 1)]
        self._i += 1
        return phase

    def container_exit_code(self, name: str) -> int | None:
        return self._exit_code


class FakeClock:
    """Monotonic clock that advances by a fixed step on every sleep()."""

    def __init__(self, step: float = 1.0) -> None:
        self.t = 0.0
        self.step = step
        self.sleeps = 0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps += 1
        self.t += self.step


def test_reaches_succeeded_after_polling():
    clock = FakeClock()
    cluster = ScriptedCluster(["Pending", "Running", "Succeeded"], exit_code=0)
    outcome = watch_pod(
        cluster, "attacker", timeout_s=100, now=clock.now, sleep=clock.sleep
    )
    assert outcome == PodOutcome(phase="Succeeded", exit_code=0)
    assert clock.sleeps == 2  # polled Pending, Running, then Succeeded


def test_terminal_on_first_poll_never_sleeps():
    clock = FakeClock()
    cluster = ScriptedCluster(["Succeeded"])
    outcome = watch_pod(cluster, "attacker", timeout_s=100, now=clock.now, sleep=clock.sleep)
    assert outcome.phase == "Succeeded"
    assert clock.sleeps == 0


def test_failed_pod_reports_exit_code():
    cluster = ScriptedCluster(["Failed"], exit_code=2)
    outcome = watch_pod(cluster, "attacker", timeout_s=100, now=FakeClock().now, sleep=lambda s: None)
    assert outcome.phase == "Failed"
    assert outcome.exit_code == 2


def test_timeout_returns_last_phase_flagged():
    clock = FakeClock(step=10.0)
    # Never terminal — Running forever.
    cluster = ScriptedCluster(["Running"])
    outcome = watch_pod(
        cluster, "attacker", timeout_s=25, now=clock.now, sleep=clock.sleep
    )
    assert outcome.timed_out is True
    assert outcome.phase == "Running"


# --- wait_pod_running (M8 registry readiness) --------------------------------


def test_wait_running_true_when_pod_comes_up():
    clock = FakeClock()
    cluster = ScriptedCluster(["Pending", "Running"])
    assert wait_pod_running(cluster, "registry", timeout_s=100, now=clock.now, sleep=clock.sleep) is True
    assert clock.sleeps == 1


def test_wait_running_false_when_pod_dies():
    # A registry that reaches a terminal phase never became usable -> False.
    cluster = ScriptedCluster(["Failed"])
    assert wait_pod_running(cluster, "registry", timeout_s=100, now=FakeClock().now, sleep=lambda s: None) is False


def test_wait_running_false_on_timeout():
    clock = FakeClock(step=10.0)
    cluster = ScriptedCluster(["Pending"])  # never Running
    assert wait_pod_running(cluster, "registry", timeout_s=25, now=clock.now, sleep=clock.sleep) is False


# --- mapping -----------------------------------------------------------------


def test_map_succeeded_is_complete():
    r = map_pod_result(PodOutcome(phase="Succeeded", exit_code=0))
    assert r.status == "complete"
    assert r.exit_code == 0


def test_map_failed_exit2_is_partial():
    r = map_pod_result(PodOutcome(phase="Failed", exit_code=2))
    assert r.status == "partial"
    assert r.exit_code == 2


def test_map_failed_other_exit_is_failed():
    r = map_pod_result(PodOutcome(phase="Failed", exit_code=1))
    assert r.status == "failed"
    assert r.exit_code == 1


def test_map_timeout_is_partial_timeout():
    r = map_pod_result(PodOutcome(phase="Running", exit_code=None, timed_out=True))
    assert r.status == "partial"
    assert r.halt_reason == "timeout"


@pytest.mark.parametrize("phase", ["Failed", None])
def test_map_non_success_no_exit_is_failed(phase):
    r = map_pod_result(PodOutcome(phase=phase, exit_code=None))
    assert r.status == "failed"
