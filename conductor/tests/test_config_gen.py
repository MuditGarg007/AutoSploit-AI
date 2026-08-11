"""C1 tests — generated run.toml round-trips and points at the right places
(docs/conductor.md C1).

The relative-`scope_file` subtlety is the component's contract with the harness
(§3.2): the toml must live in the same dir as the scope and reference the scope
by bare basename only. The harness's `load_config` is used as the independent
parser to prove a real harness would accept what we generate.
"""

from __future__ import annotations

import tomllib

import pytest

from autosploit_conductor.config_gen import ConfigGenError, write_run_config
from autosploit_conductor.context import make_context


def _context(tmp_path, engagement_id: str = "eng-1"):
    return make_context("https://github.com/acme/juice-shop", engagement_id, out_dir=tmp_path)


def test_toml_round_trips(tmp_path) -> None:
    ctx = _context(tmp_path)
    scope = tmp_path / "eng-1" / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")

    run_toml = write_run_config(ctx, scope)

    assert run_toml.exists()
    parsed = tomllib.loads(run_toml.read_text(encoding="utf-8"))
    assert parsed["model"]["id"] == "deepseek/deepseek-v4-flash"
    assert parsed["model"]["reasoning"] == "high"
    assert parsed["model"]["fallbacks"] == []
    assert parsed["budget"]["max_usd"] == 5.0
    assert parsed["budget"]["max_tokens"] == 2_000_000
    assert parsed["budget"]["max_tool_calls"] == 60
    assert parsed["output"]["dir"].endswith("runs")


def test_toml_name_and_location(tmp_path) -> None:
    ctx = _context(tmp_path, "eng-1")
    scope = tmp_path / "eng-1" / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")

    run_toml = write_run_config(ctx, scope)

    # Same dir as the scope file (§3.2) and named run.<id>.toml.
    assert run_toml.parent == scope.parent
    assert run_toml.name == "run.eng-1.toml"


def test_scope_file_is_bare_relative_basename(tmp_path) -> None:
    ctx = _context(tmp_path)
    scope = tmp_path / "eng-1" / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")

    run_toml = write_run_config(ctx, scope)
    parsed = tomllib.loads(run_toml.read_text(encoding="utf-8"))

    assert parsed["target"]["scope_file"] == "scope.yaml"
    assert "/" not in parsed["target"]["scope_file"]
    assert "\\" not in parsed["target"]["scope_file"]


def test_output_dir_lands_under_out_dir(tmp_path) -> None:
    ctx = _context(tmp_path)
    scope = tmp_path / "eng-1" / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")

    run_toml = write_run_config(ctx, scope)
    parsed = tomllib.loads(run_toml.read_text(encoding="utf-8"))

    assert parsed["output"]["dir"] == (ctx.out_dir / "runs").as_posix()


def test_harness_load_config_accepts_generated_toml(tmp_path) -> None:
    """The real harness parser is the authority — prove it accepts our file."""
    from autosploit_harness.driver.config import load_config

    ctx = _context(tmp_path)
    scope = tmp_path / "eng-1" / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")

    run_toml = write_run_config(ctx, scope)
    cfg = load_config(run_toml)

    assert cfg.model_id == "deepseek/deepseek-v4-flash"
    assert cfg.scope_file == scope.resolve()
    assert cfg.output_dir == (ctx.out_dir / "runs").resolve()


def test_missing_scope_file_raises(tmp_path) -> None:
    """Fail closed: never emit a toml pointing at a scope that isn't there."""
    ctx = _context(tmp_path)
    scope = tmp_path / "eng-1" / "does-not-exist.yaml"

    with pytest.raises(ConfigGenError):
        write_run_config(ctx, scope)


def test_generated_id_in_toml_name(tmp_path) -> None:
    ctx = _context(tmp_path, "eng.2-x")
    scope = tmp_path / "eng.2-x" / "scope.yaml"
    scope.write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")

    run_toml = write_run_config(ctx, scope)
    assert run_toml.name == "run.eng.2-x.toml"
