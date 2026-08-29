"""sweep — the model sweep + primary-model decision (docs/harness.md §8, §9 step 4).

Runs the loop across a set of models against the SAME scored target, scores each
run (score.py), stacks the ScoreCards, and recommends the primary from data:
exploit score first, tool-call quality (§6.1) as the tie-breaker. The OpenRouter
swap makes this a config sweep, not a rewrite (§0, §6.1) — a run is one config
line's difference (the model id), so the sweep just varies that line.

The runner is injectable. `_default_run_fn` drives the real driver (needs a live
target + OPENROUTER_API_KEY); tests pass a fake run_fn that returns a prebuilt run
directory, so the sweep + ranking logic is provable offline. Live sweeps run
`deepseek/deepseek-v4-flash` only for now (project decision); Kimi / GLM slot into
the same `models` list when the data says to compare them.
"""

from __future__ import annotations

import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from score import ScoreCard, score_run
from solutions import Solution, load_spec

# Live sweeps default to Flash alone (docs/harness.md §0, project decision). Add
# the fallbacks here to compare when score data calls for it.
DEFAULT_MODELS = ("deepseek/deepseek-v4-flash",)

RunFn = Callable[[str, Path], Path]


@dataclass(frozen=True, slots=True)
class SweepResult:
    """One sweep: every model's ScoreCard + the data-driven primary pick."""

    cards: list[ScoreCard]
    primary: str | None
    rationale: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "primary": self.primary,
            "rationale": self.rationale,
            "cards": [c.to_dict() for c in self.cards],
        }


def _rank_key(card: ScoreCard) -> tuple:
    """Sort key for picking the primary (higher is better; cost breaks ties down).

    Exploitation is the point of the harness, so it leads; then tool-call quality
    (the §6.1 model-choice metric); then coverage; then cheaper wins."""
    return (
        card.exploited_count,
        round(card.tool_call.well_formed_rate, 4),
        card.found_count,
        -card.usd,  # cheaper is better among otherwise-equal models
    )


def recommend_primary(cards: list[ScoreCard]) -> tuple[str | None, str]:
    """Pick the primary model from the scored runs (§8). Returns (model, why)."""
    ranked = [c for c in cards if c.model]
    if not ranked:
        return None, "no scored runs with a known model — cannot recommend a primary"
    best = max(ranked, key=_rank_key)
    rationale = (
        f"{best.model}: exploited {best.exploited_count}/{best.solution_count}, "
        f"found {best.found_count}/{best.solution_count}, tool-call well-formed "
        f"{best.tool_call.well_formed_rate:.0%} "
        f"({best.tool_call.executed}/{best.tool_call.attempts} executed), "
        f"${best.usd:.4f}."
    )
    return best.model, rationale


def _default_run_fn(model_id: str, base_config: Path) -> Path:
    """Drive the real driver for one model, return the run directory it wrote.

    Writes a temp config that overrides only [model].id, runs the engagement, and
    resolves the new run dir by diffing the output directory (driver.run stamps a
    fresh timestamp dir per run). Needs a live target + API key — the sweep's real
    side; tests inject a fake instead."""
    from autosploit_harness.driver.config import (
        load_config,
    )
    from autosploit_harness.driver.run import run

    cfg = load_config(base_config)
    before = set(cfg.output_dir.glob("*")) if cfg.output_dir.exists() else set()

    override = _write_model_override(base_config, model_id)
    try:
        run(override)
    finally:
        override.unlink(missing_ok=True)

    after = set(cfg.output_dir.glob("*"))
    new_dirs = [p for p in (after - before) if p.is_dir()]
    if not new_dirs:
        raise RuntimeError(f"sweep: no new run directory under {cfg.output_dir} for {model_id}")
    return max(new_dirs, key=lambda p: p.stat().st_mtime)


def _write_model_override(base_config: Path, model_id: str) -> Path:
    """Copy base_config's TOML with [model].id swapped, next to the original so
    its relative scope_file / output.dir still resolve. Returns the temp path."""
    raw = tomllib.loads(base_config.read_text(encoding="utf-8"))
    raw.setdefault("model", {})["id"] = model_id
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    safe = model_id.replace("/", "_")
    out = base_config.parent / f".sweep.{safe}.{stamp}.toml"
    out.write_text(_dump_toml(raw), encoding="utf-8")
    return out


def _dump_toml(data: dict[str, Any]) -> str:
    """Minimal TOML writer for the sweep override (one level of tables, scalar +
    list values — all the run config uses). Avoids a tomli-w dependency."""
    lines: list[str] = []
    scalars = {k: v for k, v in data.items() if not isinstance(v, dict)}
    for key, value in scalars.items():
        lines.append(f"{key} = {_toml_value(value)}")
    for table, body in data.items():
        if not isinstance(body, dict):
            continue
        lines.append(f"\n[{table}]")
        for key, value in body.items():
            lines.append(f"{key} = {_toml_value(value)}")
    return "\n".join(lines) + "\n"


def _toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_toml_value(v) for v in value) + "]"
    return '"' + str(value).replace('"', '\\"') + '"'


def sweep(
    base_config: Path,
    *,
    models: tuple[str, ...] = DEFAULT_MODELS,
    solutions: list[Solution] | None = None,
    run_fn: RunFn = _default_run_fn,
) -> SweepResult:
    """Run + score each model against the target in base_config, pick the primary.

    `run_fn(model_id, base_config) -> run_dir` is the seam: the default drives the
    live driver, tests inject a fake. Scoring reads each run's on-disk artifacts
    (score.py) against the documented solutions (§8)."""
    sols = solutions if solutions is not None else load_spec()
    cards: list[ScoreCard] = []
    for model_id in models:
        run_dir = run_fn(model_id, base_config)
        card = score_run(run_dir, solutions=sols)
        # The driver may not stamp the model into the stream on a clean run; the
        # sweep knows which model it drove, so fill it in when scoring couldn't.
        if card.model is None:
            card = _with_model(card, model_id)
        cards.append(card)

    primary, rationale = recommend_primary(cards)
    return SweepResult(cards=cards, primary=primary, rationale=rationale)


def _with_model(card: ScoreCard, model_id: str) -> ScoreCard:
    """Return a copy of the card with the model filled in (frozen dataclass)."""
    from dataclasses import replace

    return replace(card, model=model_id)
