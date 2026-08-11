"""C2 tests — provisioner invocation via a fake `provision` script (docs/conductor.md C2).

The seam: `invoke_provision(..., provision_cmd=<fake>)` drives a tiny fake
provisioner CLI instead of the real one, so the handoff parsing + fail-closed
rules are proven deterministically — no Docker, no network. The fake mirrors the
real CLI contract (Seam A): prints exactly `scope=…` then `manifest=…` on
success, exits non-zero on failure (already torn down), never talks on stdout
otherwise.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from autosploit_conductor.context import make_context
from autosploit_conductor.provision import (
    Handoff,
    HandoffParseError,
    ProvisionFailed,
    invoke_provision,
)


def _fake_provision(tmp_path: Path, body: str) -> Path:
    """Write a tiny fake provisioner CLI and return its path (runs via sys.executable)."""
    fake = tmp_path / "fake_provision.py"
    fake.write_text(f"import sys\n{body}\n", encoding="utf-8")
    return fake


def _ctx(tmp_path: Path):
    return make_context("https://github.com/acme/juice-shop", "eng-1", out_dir=tmp_path)


def test_happy_path_parses_handoff(tmp_path: Path) -> None:
    """Success → Handoff with the exact scope/manifest paths printed."""
    ctx = _ctx(tmp_path)
    scope = ctx.out_dir / "scope.yaml"
    manifest = ctx.out_dir / "provision.json"
    # The fake ignores the CLI args and prints the two handoff lines; the paths
    # are passed via env vars so Windows backslashes don't break the script text.
    fake = _fake_provision(
        tmp_path,
        "import os\n"
        "print('scope=' + os.environ['FAKE_SCOPE'])\n"
        "print('manifest=' + os.environ['FAKE_MANIFEST'])\n",
    )

    import os

    env = {**os.environ, "FAKE_SCOPE": str(scope), "FAKE_MANIFEST": str(manifest)}

    handoff = invoke_provision(
        "https://github.com/acme/juice-shop",
        ctx,
        provision_cmd=[sys.executable, str(fake)],
        timeout_s=30.0,
        env=env,
    )

    assert isinstance(handoff, Handoff)
    assert handoff.scope_path == scope
    assert handoff.manifest_path == manifest


def test_nonzero_exit_raises_provision_failed(tmp_path: Path) -> None:
    """Non-zero exit → ProvisionFailed with stderr surfaced (§8)."""
    ctx = _ctx(tmp_path)
    fake = _fake_provision(
        tmp_path,
        "print('no Docker daemon', file=sys.stderr)\nsys.exit(1)\n",
    )

    with pytest.raises(ProvisionFailed) as excinfo:
        invoke_provision("repo", ctx, provision_cmd=[sys.executable, str(fake)], timeout_s=30.0)

    assert "1" in str(excinfo.value)
    assert "no Docker daemon" in str(excinfo.value)


def test_missing_handoff_lines_fail_closed(tmp_path: Path) -> None:
    """Exit 0 but no handoff → HandoffParseError, never a default (fail closed)."""
    ctx = _ctx(tmp_path)
    fake = _fake_provision(tmp_path, "print('all good')\n")

    with pytest.raises(HandoffParseError):
        invoke_provision("repo", ctx, provision_cmd=[sys.executable, str(fake)], timeout_s=30.0)


def test_partial_handoff_fails_closed(tmp_path: Path) -> None:
    """Only `scope=…` → still a HandoffParseError (both lines required)."""
    ctx = _ctx(tmp_path)
    fake = _fake_provision(tmp_path, "print('scope=/tmp/scope.yaml')\n")

    with pytest.raises(HandoffParseError):
        invoke_provision("repo", ctx, provision_cmd=[sys.executable, str(fake)], timeout_s=30.0)


def test_stderr_surfaced_on_failure(tmp_path: Path) -> None:
    """The provisioner's stderr must be part of the raised error message."""
    ctx = _ctx(tmp_path)
    fake = _fake_provision(
        tmp_path,
        "print('boot failed: log tail', file=sys.stderr)\nsys.exit(1)\n",
    )

    with pytest.raises(ProvisionFailed) as excinfo:
        invoke_provision("repo", ctx, provision_cmd=[sys.executable, str(fake)], timeout_s=30.0)

    assert "boot failed: log tail" in str(excinfo.value)


def test_provisioner_argv_never_shell(tmp_path: Path) -> None:
    """The id/repo go as argv elements, never a shell string (§8)."""
    ctx = _ctx(tmp_path)
    fake = _fake_provision(
        tmp_path,
        "import json\nprint(json.dumps(sys.argv))\n",
    )

    # The fake echoes its argv as JSON to stdout; exit 0 but no handoff, so the
    # HandoffParseError must surface the argv verbatim — proving argv-list form,
    # not a shell-joined string (and that the id never became part of a shell).
    with pytest.raises(HandoffParseError) as excinfo:
        invoke_provision(
            "https://github.com/acme/juice-shop",
            ctx,
            provision_cmd=[sys.executable, str(fake)],
            timeout_s=30.0,
        )

    assert "eng-1" in str(excinfo.value)
    assert "https://github.com/acme/juice-shop" in str(excinfo.value)
