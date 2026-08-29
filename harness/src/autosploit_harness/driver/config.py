"""config — load + validate run inputs (docs/harness.md §1).

Reads two files into typed config:
  - run.toml   model id, reasoning effort, budget caps, target, output dir (§6, §6.2)
  - scope.yaml target host + ports → ScopeAllowlist frozen dataclass (contracts/scope.py)

Validation is fail-closed: a missing/malformed scope file aborts the run before
the graph starts — never launch an engagement with an unparseable scope (§3).
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

import yaml

from autosploit_harness.contracts.scope import ScopeAllowlist


@dataclass(frozen=True, slots=True)
class RunConfig:
    """Typed run config parsed from run.toml (+ the resolved scope path)."""

    model_id: str
    reasoning: str | None
    fallbacks: tuple[str, ...]
    max_usd: float
    max_tokens: int
    max_tool_calls: int
    scope_file: Path
    output_dir: Path


def load_scope(path: Path) -> ScopeAllowlist:
    """Parse scope.yaml → frozen ScopeAllowlist. Fail-closed on missing/malformed."""
    if not path.exists():
        raise FileNotFoundError(f"scope file not found: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    target = raw.get("target")
    if not isinstance(target, dict):
        raise ValueError(f"scope file {path}: missing 'target' mapping")  # noqa: TRY004  config validation, ValueError is the right signal
    host = target.get("host")
    ports = target.get("ports")
    if not host or not isinstance(ports, list) or not ports:
        raise ValueError(f"scope file {path}: 'target' needs a host and a non-empty ports list")
    return ScopeAllowlist(host=str(host), ports=tuple(int(p) for p in ports))


def load_config(path: Path) -> RunConfig:
    """Parse run.toml → RunConfig. The scope path is resolved relative to run.toml."""
    if not path.exists():
        raise FileNotFoundError(f"run config not found: {path}")
    raw = tomllib.loads(path.read_text(encoding="utf-8"))

    model = raw.get("model", {})
    budget = raw.get("budget", {})
    target = raw.get("target", {})
    output = raw.get("output", {})

    model_id = model.get("id")
    if not model_id:
        raise ValueError(f"run config {path}: [model].id is required")

    scope_rel = target.get("scope_file")
    if not scope_rel:
        raise ValueError(f"run config {path}: [target].scope_file is required")
    scope_file = (path.parent / scope_rel).resolve()

    output_dir = (path.parent / output.get("dir", "runs")).resolve()

    return RunConfig(
        model_id=str(model_id),
        reasoning=model.get("reasoning"),
        fallbacks=tuple(model.get("fallbacks", [])),
        max_usd=float(budget.get("max_usd", 0.0)),
        max_tokens=int(budget.get("max_tokens", 0)),
        max_tool_calls=int(budget.get("max_tool_calls", 0)),
        scope_file=scope_file,
        output_dir=output_dir,
    )
