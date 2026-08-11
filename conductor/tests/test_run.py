"""C5 tests — orchestrator + CLI: one command chains fakes + tears down
(docs/conductor.md C5).

Integration-style but still deterministic — no Docker, no network. A fake
provisioner CLI prints the `scope=`/`manifest=` handoff, a fake harness reads
its injected `OPENROUTER_API_KEY`, writes a `report.json` into the run output
dir, and exits 0/2/5 as scripted. Both are driven through the `provision_cmd` /
`harness_cmd` seams of `run()`, so the full chain — context → provision →
config_gen → launch → result → teardown → record — is proven without a daemon.

The C5 gate: one command chains fake provisioner → fake harness → teardown with
correct statuses; the failure path leaves zero residue. The run record
(conductor.json) is the ONE file allowed to survive the engagement (§4 [7],
record.py) — the out-dir's work artifacts (scope, run.toml, runs/) are removed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from autosploit_conductor.run import run

FAKE_KEY = "sk-or-test-key-1234567890"  # >= 8 chars so redaction is active


# ---- fake CLIs ---------------------------------------------------------------


def _fake_provision(tmp_path: Path, *, exit_code: int = 0, write_scope: bool = True) -> Path:
    """A fake `provision` CLI: writes scope.yaml + provision.json, prints the handoff.

    The scope is written into the engagement out-dir the fake receives via its
    `--out` arg (mirroring the real provisioner, which emits into `<out>/<id>/`),
    so the relative-`scope_file` subtlety is exercised for real: the generated
    run.toml lands in the same dir and must point at `scope.yaml`. With
    `write_scope=False` the handoff is missing entirely (exit 0 but no scope=…)
    — the fail-closed path.
    """
    body = f"""\
import json, os, sys
from pathlib import Path

argv = sys.argv
repo, out = argv[1], Path(argv[-1])  # --out is the last arg (base out-dir)
out.mkdir(parents=True, exist_ok=True)
scope = out / "scope.yaml"
manifest = out / "provision.json"
if {int(write_scope)}:
    scope.write_text("target: {{host: 127.0.0.1, ports: [3000]}}\\n", encoding="utf-8")
    manifest.write_text(json.dumps({{"engagement_id": out.name}}), encoding="utf-8")
    print(f"scope={{scope}}")
    print(f"manifest={{manifest}}")
sys.exit({exit_code})
"""
    fake = tmp_path / "fake_provision.py"
    fake.write_text(body, encoding="utf-8")
    return fake


def _fake_harness(tmp_path: Path, *, exit_code: int = 0) -> Path:
    """A fake `autosploit-harness` CLI: writes report.json, then exits `exit_code`.

    Writes the report into the run output dir from the generated run.toml's
    `[output].dir` (exercising that the conductor generated a config the harness
    would actually consume), and verifies the injected key is present.
    """
    body = f"""\
import json, os, sys, tomllib
from pathlib import Path

config = Path(sys.argv[sys.argv.index("--config") + 1])
raw = tomllib.loads(config.read_text(encoding="utf-8"))
out_dir = Path(raw["output"]["dir"])
out_dir.mkdir(parents=True, exist_ok=True)
has_key = bool(os.environ.get("OPENROUTER_API_KEY"))
halt = None if {exit_code} == 0 else "fake-halt" if {exit_code} == 2 else None
(out_dir / "report.json").write_text(
    json.dumps({{
        "completed": {{"0": True, "2": False}}.get(str({exit_code}), False),
        "halt_reason": halt,
        "key_present": has_key,
    }}),
    encoding="utf-8",
)
print("fake harness: run complete", flush=True)
sys.exit({exit_code})
"""
    fake = tmp_path / "fake_harness.py"
    fake.write_text(body, encoding="utf-8")
    return fake


# ---- fixtures ----------------------------------------------------------------


def _ctx_args(tmp_path: Path, engagement_id: str = "eng-1") -> dict:
    return {
        "repo_ref": "https://github.com/acme/juice-shop",
        "engagement_id": engagement_id,
        "out_dir": tmp_path,
        "timeout_s": 30.0,
        "env": {"OPENROUTER_API_KEY": FAKE_KEY},
    }


def _read_record(record_path: Path) -> dict:
    return json.loads(record_path.read_text(encoding="utf-8"))


# ---- full chain --------------------------------------------------------------


def test_run_full_chain(tmp_path: Path) -> None:
    """Happy path: provision → harness exit 0 → complete, work removed, record written."""
    fake_provision = _fake_provision(tmp_path)
    fake_harness = _fake_harness(tmp_path, exit_code=0)

    result, record_path = run(
        **_ctx_args(tmp_path),
        provision_cmd=[sys.executable, str(fake_provision)],
        harness_cmd=[sys.executable, str(fake_harness)],
    )

    assert result.status == "complete"
    assert result.exit_code == 0
    assert result.report_path is not None
    # The harness saw the injected key (env injection proved end-to-end). The
    # report was written by the harness and then removed by teardown with the
    # workdir — so the key evidence is the run record, which references it.
    assert result.report_path.name == "report.json"

    # Teardown removed the engagement workdir (zero residue of the run itself);
    # the record — the ONE surviving artifact — was written after teardown.
    assert record_path is not None
    assert record_path == tmp_path / "eng-1" / "conductor.json"
    record = _read_record(record_path)
    assert record["engagement_id"] == "eng-1"
    assert record["status"] == "complete"
    assert record["provision"]["ok"] is True
    assert record["harness"]["status"] == "complete"
    assert record["harness"]["report_path"] is not None
    # The work artifacts are gone (only the record remains in the out-dir).
    assert not (tmp_path / "eng-1" / "scope.yaml").exists()
    assert not (tmp_path / "eng-1" / "run.eng-1.toml").exists()
    assert not (tmp_path / "eng-1" / "runs").exists()


def test_run_partial_halt(tmp_path: Path) -> None:
    """Harness exit 2 → partial (halted but reported) — still a success for the lifecycle."""
    fake_provision = _fake_provision(tmp_path)
    fake_harness = _fake_harness(tmp_path, exit_code=2)

    result, record_path = run(
        **_ctx_args(tmp_path),
        provision_cmd=[sys.executable, str(fake_provision)],
        harness_cmd=[sys.executable, str(fake_harness)],
    )

    assert result.status == "partial"
    assert result.halt_reason == "fake-halt"
    assert record_path is not None
    record = _read_record(record_path)
    assert record["status"] == "partial"
    assert record["harness"]["status"] == "partial"
    assert record["harness"]["halt_reason"] == "fake-halt"


def test_run_harness_failure(tmp_path: Path) -> None:
    """Harness exit 5 → failed(harness); teardown still runs, record still written."""
    fake_provision = _fake_provision(tmp_path)
    fake_harness = _fake_harness(tmp_path, exit_code=5)

    result, record_path = run(
        **_ctx_args(tmp_path),
        provision_cmd=[sys.executable, str(fake_provision)],
        harness_cmd=[sys.executable, str(fake_harness)],
    )

    assert result.status == "failed"
    assert result.exit_code == 5
    assert record_path is not None
    record = _read_record(record_path)
    assert record["status"] == "failed"
    assert record["harness"]["status"] == "failed"
    assert record["harness"]["exit_code"] == 5


def test_run_provision_failure_leaves_zero_residue(tmp_path: Path) -> None:
    """Provision exits non-zero → failed(provision), no harness, work removed (§8)."""
    fake_provision = _fake_provision(tmp_path, exit_code=1)
    fake_harness = _fake_harness(tmp_path, exit_code=0)

    result, record_path = run(
        **_ctx_args(tmp_path),
        provision_cmd=[sys.executable, str(fake_provision)],
        harness_cmd=[sys.executable, str(fake_harness)],
    )

    assert result.status == "failed"
    assert result.exit_code == 1
    # The harness must never have run — the fake writes its report only when run.
    assert not (tmp_path / "eng-1" / "runs" / "report.json").exists()
    # The record reflects the failed provision and no harness.
    assert record_path is not None
    record = _read_record(record_path)
    assert record["provision"]["ok"] is False
    assert record["provision"]["error"] is not None
    assert record["harness"] is None
    # Zero residue: the run's work artifacts are gone (only the record remains).
    assert not (tmp_path / "eng-1" / "scope.yaml").exists()


def test_run_bad_scope_fails_closed(tmp_path: Path) -> None:
    """A provision that prints no scope=… line must fail closed — never launch."""
    fake_provision = _fake_provision(tmp_path, write_scope=False)
    fake_harness = _fake_harness(tmp_path, exit_code=0)

    result, record_path = run(
        **_ctx_args(tmp_path),
        provision_cmd=[sys.executable, str(fake_provision)],
        harness_cmd=[sys.executable, str(fake_harness)],
    )

    assert result.status == "failed"
    assert record_path is not None
    record = _read_record(record_path)
    assert record["provision"]["ok"] is False
    assert record["harness"] is None


# ---- CLI ---------------------------------------------------------------------


def _cli_main(args: list[str], tmp_path: Path, *, provision_exit: int = 0, harness_exit: int = 0) -> int:
    from autosploit_conductor.cli import main

    fake_provision = _fake_provision(tmp_path, exit_code=provision_exit)
    fake_harness = _fake_harness(tmp_path, exit_code=harness_exit)

    # The CLI calls `run` with default seams (real provisioner/harness console
    # scripts); patch the module's run to inject our fakes + the test key env.
    import autosploit_conductor.cli as cli_module

    def _run(repo, engagement_id=None, out_dir=".", timeout_s=None, api_key=None):
        return run(
            repo,
            engagement_id=engagement_id,
            out_dir=out_dir,
            timeout_s=timeout_s,
            api_key=api_key or FAKE_KEY,
            provision_cmd=[sys.executable, str(fake_provision)],
            harness_cmd=[sys.executable, str(fake_harness)],
            env={"OPENROUTER_API_KEY": FAKE_KEY},
        )

    original = cli_module.run
    cli_module.run = _run  # type: ignore[attr-defined]
    try:
        return main(args)
    finally:
        cli_module.run = original


def test_cli_run_exit_zero_on_complete(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    """`conductor run <repo> …` exits 0 and prints report=… + record=… on a full run."""
    code = _cli_main(
        [
            "run",
            "https://github.com/acme/juice-shop",
            "--engagement-id",
            "eng-1",
            "--out",
            str(tmp_path),
        ],
        tmp_path,
    )

    assert code == 0
    out = capsys.readouterr().out
    assert "report=" in out
    assert "record=" in out


def test_cli_run_partial_still_zero(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    """A halted run still exits 0 (a report exists); the record carries the halt."""
    code = _cli_main(
        [
            "run",
            "https://github.com/acme/juice-shop",
            "--engagement-id",
            "eng-1",
            "--out",
            str(tmp_path),
        ],
        tmp_path,
        harness_exit=2,
    )

    assert code == 0
    out = capsys.readouterr().out
    assert "report=" in out


def test_cli_run_failed_exits_nonzero(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    """failed(harness) → non-zero exit; the failure is still recorded, not fatal."""
    code = _cli_main(
        [
            "run",
            "https://github.com/acme/juice-shop",
            "--engagement-id",
            "eng-1",
            "--out",
            str(tmp_path),
        ],
        tmp_path,
        harness_exit=5,
    )

    assert code == 1
    out = capsys.readouterr().out
    assert "report=" in out  # the fake harness wrote a report even on exit 5


def test_cli_run_provision_failure_exits_nonzero(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """failed(provision) → non-zero exit, stderr surfaced, no report line."""
    code = _cli_main(
        [
            "run",
            "https://github.com/acme/juice-shop",
            "--engagement-id",
            "eng-1",
            "--out",
            str(tmp_path),
        ],
        tmp_path,
        provision_exit=1,
    )

    assert code == 1
    out = capsys.readouterr().out
    assert "report=" not in out
    assert "record=" in out
