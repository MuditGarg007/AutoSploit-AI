"""score — Juice Shop scoring (docs/harness.md §8).

Grades one run off its on-disk artifacts (artifacts.load_run) — the same the
dashboard reads (§8) — against the documented-solution answer key (solutions.py).
Per Juice Shop's documented solutions:
  - Found the planted vuln class? Exploited it (not just flagged)?
  - Cost (tokens + $), step count, wall time.
  - False positives (findings that don't hold up).
  - Tool-call success rate (§6.1, metrics.py) — the model-choice risk metric.

Lives OUTSIDE the package (eval/, not src/) because it CONSUMES the driver — it
doesn't ship inside the harness. Same code, scored targets (§8). The ScoreCard is
one run's row; sweep.py stacks these across models to pick the primary from data.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from artifacts import RunArtifacts, load_run
from metrics import ToolCallMetrics, tool_call_metrics
from solutions import Solution, SolutionOutcome, load_spec, match


@dataclass(frozen=True, slots=True)
class ScoreCard:
    """One run's score — coverage + exploitation + cost + tool-call quality (§8)."""

    run_dir: str
    model: str | None
    completed: bool
    halt_reason: str | None
    # coverage vs the documented solutions
    outcomes: list[SolutionOutcome]
    found_count: int
    exploited_count: int
    solution_count: int
    false_positives: list[dict[str, Any]]
    # cost + effort
    tokens: int
    usd: float
    turns: int
    tool_results: int
    tool_calls: int
    wall_time_seconds: float | None
    # the model-choice risk metric (§6.1)
    tool_call: ToolCallMetrics

    @property
    def found_rate(self) -> float:
        return self.found_count / self.solution_count if self.solution_count else 0.0

    @property
    def exploited_rate(self) -> float:
        return self.exploited_count / self.solution_count if self.solution_count else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_dir": self.run_dir,
            "model": self.model,
            "completed": self.completed,
            "halt_reason": self.halt_reason,
            "coverage": {
                "found": self.found_count,
                "exploited": self.exploited_count,
                "total": self.solution_count,
                "found_rate": round(self.found_rate, 4),
                "exploited_rate": round(self.exploited_rate, 4),
                "solutions": [o.to_dict() for o in self.outcomes],
            },
            "false_positives": self.false_positives,
            "cost": {"tokens": self.tokens, "usd": self.usd},
            "effort": {
                "turns": self.turns,
                "tool_results": self.tool_results,
                "tool_calls": self.tool_calls,
                "wall_time_seconds": self.wall_time_seconds,
            },
            "tool_call": self.tool_call.to_dict(),
        }


def _model_of(artifacts: RunArtifacts) -> str | None:
    """The model that ran, from the first refusal event or a cost event — best
    effort. None when the stream never named one."""
    for event in artifacts.events:
        model = (event.get("data") or {}).get("model")
        if model:
            return str(model)
    return None


def score_run(run_dir: Path, *, solutions: list[Solution] | None = None) -> ScoreCard:
    """Score one run directory against the documented solutions (§8)."""
    artifacts = load_run(run_dir)
    return score_artifacts(artifacts, solutions=solutions)


def score_artifacts(
    artifacts: RunArtifacts, *, solutions: list[Solution] | None = None
) -> ScoreCard:
    """Score already-loaded artifacts — the injectable core (tests pass synthetic
    artifacts; score_run loads from disk)."""
    sols = solutions if solutions is not None else load_spec()
    outcomes, false_positives = match(artifacts.findings, sols)

    report = artifacts.report
    budget = report.get("budget") or {}

    return ScoreCard(
        run_dir=str(artifacts.run_dir),
        model=_model_of(artifacts),
        completed=bool(report.get("completed")),
        halt_reason=report.get("halt_reason"),
        outcomes=outcomes,
        found_count=sum(1 for o in outcomes if o.found),
        exploited_count=sum(1 for o in outcomes if o.exploited),
        solution_count=len(outcomes),
        false_positives=false_positives,
        tokens=int(budget.get("tokens", 0)),
        usd=float(budget.get("usd", 0.0)),
        turns=int(report.get("turns", 0)),
        tool_results=int(report.get("tool_results", 0)),
        tool_calls=int(budget.get("tool_calls", 0)),
        wall_time_seconds=artifacts.wall_time_seconds(),
        tool_call=tool_call_metrics(artifacts.events),
    )
