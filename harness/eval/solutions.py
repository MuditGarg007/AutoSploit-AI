"""solutions — the scored-target answer key (docs/harness.md §8).

Loads the documented-solution spec (solutions.<target>.yaml) and matches a run's
findings against it. Juice Shop ships documented solutions per challenge (§0);
this is that answer key in a form the scorer can read: per vuln class, the
keyword phrases that mark a finding as FOUND (identified the class) and the
stronger phrases that mark it EXPLOITED (proof, not just a flag — §8).

Matching is keyword-heuristic by design: findings are free text the model wrote
(§5), so there is no exact key to join on. The spec is data (YAML), not code, so
tuning it against real runs never touches the scorer. `false_positive` findings —
ones that match no solution — fall out of the same pass for the §8 FP metric.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# The spec lives next to this module; a target override is passable to load_spec.
DEFAULT_SPEC = Path(__file__).with_name("solutions.juiceshop.yaml")


@dataclass(frozen=True, slots=True)
class Solution:
    """One planted vuln class from the target's documented solutions (§8)."""

    id: str
    title: str
    vuln_class: str
    severity: str
    found_any: tuple[str, ...]  # any → the class was identified (FOUND)
    exploit_any: tuple[str, ...]  # any (and found) → it was EXPLOITED, not flagged


@dataclass(frozen=True, slots=True)
class SolutionOutcome:
    """How one run scored against one solution."""

    solution: Solution
    found: bool
    exploited: bool
    matched_finding_ids: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.solution.id,
            "title": self.solution.title,
            "vuln_class": self.solution.vuln_class,
            "found": self.found,
            "exploited": self.exploited,
            "matched_finding_ids": list(self.matched_finding_ids),
        }


def load_spec(path: Path | None = None) -> list[Solution]:
    """Parse the solution spec YAML → list[Solution]. Fail-closed on a bad file."""
    spec_path = Path(path) if path is not None else DEFAULT_SPEC
    if not spec_path.exists():
        raise FileNotFoundError(f"solution spec not found: {spec_path}")
    raw = yaml.safe_load(spec_path.read_text(encoding="utf-8")) or {}
    entries = raw.get("solutions")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"solution spec {spec_path}: needs a non-empty 'solutions' list")

    solutions: list[Solution] = []
    for entry in entries:
        solutions.append(
            Solution(
                id=str(entry["id"]),
                title=str(entry.get("title", entry["id"])),
                vuln_class=str(entry.get("vuln_class", "unknown")),
                severity=str(entry.get("severity", "info")),
                found_any=tuple(str(k).lower() for k in entry.get("found_any", [])),
                exploit_any=tuple(str(k).lower() for k in entry.get("exploit_any", [])),
            )
        )
    return solutions


def _finding_text(finding: dict[str, Any]) -> str:
    """Lowercased title + evidence + repro — the haystack a solution matches on."""
    parts = (finding.get("title"), finding.get("evidence"), finding.get("repro"))
    return " \n ".join(str(p) for p in parts if p).lower()


def _matches_any(text: str, phrases: tuple[str, ...]) -> bool:
    return any(phrase and phrase in text for phrase in phrases)


def match(
    findings: list[dict[str, Any]], solutions: list[Solution]
) -> tuple[list[SolutionOutcome], list[dict[str, Any]]]:
    """Score findings against the spec (§8).

    Returns (outcomes, false_positives):
      - one SolutionOutcome per solution — found / exploited + the finding ids
        that matched it.
      - false_positives: findings that matched NO solution (candidate FPs the §8
        metric flags for human confirmation — heuristic, not a verdict).
    """
    texts = [(f, _finding_text(f)) for f in findings]
    matched_ids: set[str] = set()

    outcomes: list[SolutionOutcome] = []
    for sol in solutions:
        hits: list[str] = []
        exploited = False
        for finding, text in texts:
            if _matches_any(text, sol.found_any):
                fid = str(finding.get("id", "?"))
                hits.append(fid)
                matched_ids.add(fid)
                if _matches_any(text, sol.exploit_any):
                    exploited = True
        outcomes.append(
            SolutionOutcome(
                solution=sol,
                found=bool(hits),
                exploited=exploited,
                matched_finding_ids=tuple(hits),
            )
        )

    false_positives = [f for f in findings if str(f.get("id", "?")) not in matched_ids]
    return outcomes, false_positives
