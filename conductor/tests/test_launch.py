"""C3 tests — harness launcher via a fake harness script (docs/conductor.md C3).

The seam: `launch_harness(..., harness_cmd=<fake>)` drives a tiny fake harness
CLI instead of the real one, so env injection, streaming, exit mapping, the
timeout kill, and key redaction are proven deterministically — no model, no
network. The fake mirrors the real CLI contract (Seam B): it reads its
`OPENROUTER_API_KEY` env var, echoes lines to stdout, and exits 0/2/5 as
scripted.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from autosploit_conductor.context import make_context
from autosploit_conductor.launch import (
    EXIT_COMPLETE,
    EXIT_PARTIAL,
    LaunchError,
    _redact,
    launch_harness,
)
from autosploit_conductor.provision import Handoff

FAKE_KEY = "sk-or-test-key-1234567890"  # >= 8 chars so redaction is active


def _fake_harness(tmp_path: Path, body: str) -> Path:
    """Write a tiny fake harness CLI and return its path (runs via sys.executable)."""
    fake = tmp_path / "fake_harness.py"
    fake.write_text(f"import sys, os, time\n{body}\n", encoding="utf-8")
    return fake


def _ctx(tmp_path: Path):
    return make_context("https://github.com/acme/juice-shop", "eng-1", out_dir=tmp_path)


def _handoff(tmp_path: Path) -> Handoff:
    ctx = _ctx(tmp_path)
    scope = ctx.out_dir / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")
    return Handoff(scope_path=scope, manifest_path=ctx.out_dir / "provision.json")


def _launch(tmp_path: Path, fake: Path, *, timeout_s: float = 30.0, **kwargs):
    ctx = _ctx(tmp_path)
    run_toml = ctx.out_dir / "run.eng-1.toml"
    run_toml.write_text("[target]\nscope_file = 'scope.yaml'\n", encoding="utf-8")
    return launch_harness(
        _handoff(tmp_path),
        ctx,
        run_toml,
        FAKE_KEY,
        harness_cmd=[sys.executable, str(fake)],
        timeout_s=timeout_s,
        **kwargs,
    )


def test_key_injected_into_child_env(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """The key must reach the child's env and never appear on our stdout."""
    out_file = tmp_path / "key_probe.json"
    fake = _fake_harness(
        tmp_path,
        f"import json\nprint(json.dumps({{'has_key': bool(os.environ.get('OPENROUTER_API_KEY'))}}), file=open({str(out_file)!r}, 'w'))\nsys.exit(0)\n",
    )

    outcome = _launch(tmp_path, fake)

    assert outcome.exit_code == EXIT_COMPLETE
    assert not outcome.timed_out
    captured = out_file.read_text(encoding="utf-8").strip()
    assert '"has_key": true' in captured or '"has_key": True' in captured
    assert FAKE_KEY not in capsys.readouterr().out


def test_stdout_streamed_through(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    """The harness's stdout must reach OUR stdout as it arrives."""
    fake = _fake_harness(
        tmp_path,
        "print('phase start')\nprint('phase end')\nsys.exit(0)\n",
    )

    outcome = _launch(tmp_path, fake)

    assert outcome.exit_code == EXIT_COMPLETE
    out = capsys.readouterr().out
    assert "phase start" in out
    assert "phase end" in out


def test_exit_0_maps_complete(tmp_path: Path) -> None:
    fake = _fake_harness(tmp_path, "sys.exit(0)\n")
    outcome = _launch(tmp_path, fake)
    assert outcome.exit_code == EXIT_COMPLETE


def test_exit_2_maps_partial(tmp_path: Path) -> None:
    fake = _fake_harness(tmp_path, "sys.exit(2)\n")
    outcome = _launch(tmp_path, fake)
    assert outcome.exit_code == EXIT_PARTIAL


def test_exit_5_maps_failed(tmp_path: Path) -> None:
    fake = _fake_harness(tmp_path, "sys.exit(5)\n")
    outcome = _launch(tmp_path, fake)
    assert outcome.exit_code == 5


def test_timeout_kills_and_marks_timed_out(tmp_path: Path) -> None:
    """A child that outlives the timeout must be killed and flagged partial(timeout)."""
    fake = _fake_harness(
        tmp_path,
        "print('started', flush=True)\ntime.sleep(10)\n",
    )

    outcome = _launch(tmp_path, fake, timeout_s=0.3)

    assert outcome.timed_out
    assert outcome.exit_code == -1


def test_key_redacted_from_streamed_output(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """Belt + braces: a harness that echoes the key back must be scrubbed (§8)."""
    fake = _fake_harness(
        tmp_path,
        "print('leak: ' + os.environ['OPENROUTER_API_KEY'], flush=True)\nsys.exit(0)\n",
    )

    outcome = _launch(tmp_path, fake)

    assert outcome.exit_code == EXIT_COMPLETE
    out = capsys.readouterr().out
    assert FAKE_KEY not in out
    assert "***REDACTED***" in out


def test_redact_noop_on_short_key() -> None:
    """A short/absent key must not trigger substitution surprises."""
    assert _redact("abc", "abc") == "abc"  # key under the length floor: untouched
    assert _redact("hello world", "") == "hello world"


def test_missing_harness_raises_launch_error(tmp_path: Path) -> None:
    """A harness that can't be started surfaces LaunchError, not a traceback."""
    ctx = _ctx(tmp_path)
    run_toml = ctx.out_dir / "run.eng-1.toml"
    run_toml.write_text("", encoding="utf-8")

    with pytest.raises(LaunchError):
        launch_harness(
            _handoff(tmp_path),
            ctx,
            run_toml,
            FAKE_KEY,
            harness_cmd=[str(tmp_path / "no-such-harness")],
            timeout_s=30.0,
        )
