"""Provisioner invocation — subprocess the provisioner CLI; parse its handoff (docs/conductor.md §7 [2]).

The provisioner stays a black box: the conductor only runs its CLI and reads the
two machine-parseable `key=value` lines it prints on success:

    scope=/abs/…/scope.yaml
    manifest=/abs/…/provision.json

Rules (docs/conductor.md §8, C2):
- The target is still up after a successful provision — teardown is OUR job.
- A non-zero exit means the provisioner already tore itself down; we surface its
  stderr and raise, nothing left to clean.
- Missing/unparseable handoff lines → fail closed: never launch the harness
  without a scope path.
- The id is passed as an argv element, never through a shell string — no
  injection through an engagement id.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from autosploit_conductor.context import ConductorError, EngagementContext

# Seam A console script (provisioner/pyproject.toml [project.scripts]).
_PROVISION_CMD: Sequence[str] = ("provision",)


class ProvisionFailed(ConductorError):
    """The provisioner CLI exited non-zero. It already tore itself down (§8)."""


class HandoffParseError(ConductorError):
    """Success exit but the `scope=`/`manifest=` handoff was missing or malformed."""


@dataclass(frozen=True, slots=True)
class Handoff:
    """The provisioner's machine-parseable handoff (docs/conductor.md §3.1)."""

    scope_path: Path
    manifest_path: Path


def invoke_provision(
    repo_ref: str,
    ctx: EngagementContext,
    *,
    provision_cmd: Sequence[str] = _PROVISION_CMD,
    timeout_s: float | None = None,
    env: Mapping[str, str] | None = None,
) -> Handoff:
    """Run `provision <repo> --engagement-id <id> --out <dir>` and parse the handoff.

    Fail closed (§8): a non-zero exit raises `ProvisionFailed` (stderr surfaced —
    the provisioner already cleaned up after itself); missing or unparseable
    `scope=`/`manifest=` lines raise `HandoffParseError` even if the exit was 0.
    """
    argv = [
        *provision_cmd,
        repo_ref,
        "--engagement-id",
        ctx.engagement_id,
        "--out",
        str(ctx.out_dir),
    ]
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_s if timeout_s is not None else ctx.timeout_s,
            env=dict(os.environ) if env is None else dict(env),
        )
    except subprocess.TimeoutExpired as exc:
        raise ProvisionFailed(
            f"provisioner timed out after {timeout_s if timeout_s is not None else ctx.timeout_s}s"
        ) from exc

    if proc.returncode != 0:
        stderr = proc.stderr.strip() if proc.stderr else ""
        raise ProvisionFailed(
            f"provisioner exited {proc.returncode} for {repo_ref!r}"
            + (f": {stderr}" if stderr else "")
        )

    return _parse_handoff(proc.stdout)


def _parse_handoff(stdout: str) -> Handoff:
    """Parse the two `key=value` lines from the provisioner's stdout. Fail closed."""
    lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    values: dict[str, Path] = {}
    for line in lines:
        key, sep, value = line.partition("=")
        if not sep or not value:
            continue
        if key in ("scope", "manifest"):
            values[key] = Path(value)

    if "scope" not in values or "manifest" not in values:
        raise HandoffParseError(
            f"provisioner stdout did not contain scope=… and manifest=… "
            f"handoff lines; got: {stdout!r}"
        )

    return Handoff(scope_path=values["scope"], manifest_path=values["manifest"])
