"""Attacker launcher — harness subprocess + key injection + streaming (docs/conductor.md §7 [4]).

Builds the harness env: inherited environment + `OPENROUTER_API_KEY` injected
(the one secret, §2 trust boundary). Runs the harness CLI against the generated
run.toml (Seam B), streaming stdout/stderr through as it arrives, and enforces a
wall-clock timeout that kills the child and marks the run partial(timeout).

Key hygiene (load-bearing, §8): the key lives only in the child env, never in
the provisioner env, never written to the out-dir, never echoed to our stdout.
The harness doesn't echo it, but as belt-and-braces every streamed line is run
through `_redact` so a leak can't propagate.
"""

from __future__ import annotations

import os
import subprocess
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from autosploit_conductor.context import ConductorError, EngagementContext
from autosploit_conductor.provision import Handoff

# Seam B console script (harness/pyproject.toml [project.scripts]).
_HARNESS_CMD: Sequence[str] = ("autosploit-harness",)

# Exit codes the harness uses (Seam B §3.2): 0 complete, 2 partial, other = failure.
EXIT_COMPLETE = 0
EXIT_PARTIAL = 2


class LaunchError(ConductorError):
    """The harness subprocess failed to start (not a run failure)."""


@dataclass(frozen=True, slots=True)
class HarnessOutcome:
    """What the launcher observed: exit code + whether the timeout tripped."""

    exit_code: int
    timed_out: bool = False


def _redact(text: str, api_key: str) -> str:
    """Scrub the key from any text (belt + braces, §8). No-op for a short key."""
    if api_key and len(api_key) >= 8:
        text = text.replace(api_key, "***REDACTED***")
    return text


def _stream_line(line: str, api_key: str) -> None:
    """Emit one child output line to our stdout, key-scrubbed (§8)."""
    print(_redact(line, api_key), flush=True)


def launch_harness(
    handoff: Handoff,
    ctx: EngagementContext,
    run_toml: Path,
    api_key: str,
    *,
    harness_cmd: Sequence[str] = _HARNESS_CMD,
    timeout_s: float | None = None,
    env: Mapping[str, str] | None = None,
) -> HarnessOutcome:
    """Run `autosploit-harness run --config run.<id>.toml` with the key injected.

    The harness's stdout+stderr are streamed to our stdout line-by-line (the
    run's event feed). On timeout the child is killed and the outcome is marked
    `timed_out` so the caller can record partial(timeout) (§8).
    """
    harness_env = dict(os.environ) if env is None else dict(env)
    harness_env["OPENROUTER_API_KEY"] = api_key

    argv = [
        *harness_cmd,
        "run",
        "--config",
        str(run_toml),
    ]
    try:
        proc = subprocess.Popen(
            argv,
            env=harness_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except OSError as exc:
        raise LaunchError(f"failed to start harness {argv[0]!r}: {exc}") from exc

    assert proc.stdout is not None

    # Stream the child's merged stdout/stderr from a reader thread so a long
    # harness run can't deadlock the pipe; `proc.wait` below carries the timeout
    # and covers the whole streaming phase, not just the final reap.
    def _pump() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            _stream_line(raw.rstrip("\n"), api_key)

    pump = threading.Thread(target=_pump, name="harness-stream", daemon=True)
    pump.start()

    try:
        exit_code = proc.wait(
            timeout=timeout_s if timeout_s is not None else ctx.timeout_s
        )
        pump.join()
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return HarnessOutcome(exit_code=-1, timed_out=True)

    return HarnessOutcome(exit_code=exit_code)
