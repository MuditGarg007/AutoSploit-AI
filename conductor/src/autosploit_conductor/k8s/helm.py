"""Helm-release runner — the `helm install`/`helm uninstall` seam (M9 Phase 2).

Isolated exactly like `k8s/factory.py`: the one place the conductor shells out to
`helm`. The `run` callable (`subprocess.run` by default) is injectable, so the
whole seam unit-tests with a fake `run` — no helm binary, no cluster.

Phase B builds the engagement workload from the per-engagement chart
(`deploy/helm/engagement`, M9 Phase 1). `install_release` renders the release with
values built at run time from the provision result; `uninstall_release` removes it
on teardown. A non-zero helm exit (or a timeout) surfaces as `ConductorError` so
the CLI reports it cleanly and exits non-zero, never a raw traceback.

The Secret carrying the model key is applied imperatively by the conductor *before*
install (the chart only names it in a `secretKeyRef`), so the key value never enters
the values file this module writes.
"""

from __future__ import annotations

import subprocess
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import yaml

from autosploit_conductor.context import ConductorError

# subprocess.run-compatible callable: the injection seam for tests.
Runner = Callable[..., "subprocess.CompletedProcess[str]"]

_HELM: tuple[str, ...] = ("helm",)


def install_release(
    release: str,
    chart_dir: Path,
    namespace: str,
    values: Mapping[str, Any],
    *,
    run: Runner = subprocess.run,
    timeout_s: float | None = None,
) -> None:
    """`helm install <release> <chart_dir> -n <namespace> -f <values>`; raise on failure.

    `values` is serialized to a temporary YAML file passed via `--values`; the file
    is always removed before returning. The namespace is created imperatively by the
    conductor beforehand (M9 deviation), so no `--create-namespace` here.
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", prefix=f"{release}-values-", delete=False
    ) as fh:
        values_path = Path(fh.name)
        yaml.safe_dump(dict(values), fh, default_flow_style=False, sort_keys=True)
    try:
        argv = [
            *_HELM,
            "install",
            release,
            str(chart_dir),
            "--namespace",
            namespace,
            "--values",
            str(values_path),
        ]
        _run(argv, run=run, timeout_s=timeout_s, what=f"install release {release!r}")
    finally:
        values_path.unlink(missing_ok=True)


def uninstall_release(
    release: str,
    namespace: str,
    *,
    run: Runner = subprocess.run,
    timeout_s: float | None = None,
) -> None:
    """`helm uninstall <release> -n <namespace>`; raise `ConductorError` on failure.

    Called best-effort on teardown (the caller swallows the raise), but the seam
    still fails closed so its own tests can assert the error path.
    """
    argv = [*_HELM, "uninstall", release, "--namespace", namespace]
    _run(argv, run=run, timeout_s=timeout_s, what=f"uninstall release {release!r}")


def _run(
    argv: list[str], *, run: Runner, timeout_s: float | None, what: str
) -> None:
    """Run a helm argv; a non-zero exit or a timeout raises `ConductorError`."""
    try:
        proc = run(
            argv,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        raise ConductorError(f"helm timed out trying to {what} after {timeout_s}s") from exc

    if proc.returncode != 0:
        stderr = proc.stderr.strip() if proc.stderr else ""
        raise ConductorError(
            f"helm failed to {what} (exit {proc.returncode})"
            + (f": {stderr}" if stderr else "")
        )
