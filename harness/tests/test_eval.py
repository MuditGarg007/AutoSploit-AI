"""Eval rig tests (docs/harness.md §8, §9 step 4).

Covers the four pieces of the eval rig with no live target or network:
  - metrics.tool_call_metrics: every tool_result bucketed, both rates correct.
  - solutions.match: findings → found / exploited / false-positive.
  - score.score_artifacts: a run's artifacts → a ScoreCard.
  - sweep.sweep + recommend_primary: stack cards, pick the primary from data.

The eval modules import as top-level names via the pytest `pythonpath = [...,
"eval"]` config — the same shape eval/cli.py sets up at runtime.
"""

from __future__ import annotations

import json
from pathlib import Path

from artifacts import RunArtifacts, load_run
from metrics import tool_call_metrics
from score import score_artifacts, score_run
from solutions import load_spec, match
from sweep import recommend_primary, sweep


def _tool_result(is_error: bool, error: str = "") -> dict:
    data = {"id": "x", "name": "http_request", "is_error": is_error}
    if is_error:
        data["error"] = error
    return {"ts": "2026-08-08T00:00:00+00:00", "type": "tool_result", "data": data}


# --- metrics ---------------------------------------------------------------

def test_tool_call_metrics_buckets_every_result():
    events = [
        _tool_result(False),  # executed
        _tool_result(True, "malformed call to http_request: bad json. Reissue it..."),
        _tool_result(True, "invalid arguments for http_request: url required"),
        _tool_result(True, "BLOCKED: 8.8.8.8:80 is out of scope (allowlist: ...)"),
        _tool_result(True, "BLOCKED: run_shell with these exact arguments was already attempted"),
        _tool_result(True, "unknown tool: 'foo'"),
        _tool_result(True, "ConnectionError('boom')"),  # adapter raised
        {"type": "cost", "data": {"tokens": 10}},  # ignored — not a tool_result
    ]
    m = tool_call_metrics(events)

    assert m.attempts == 7
    assert m.executed == 1
    assert m.malformed == 1
    assert m.schema_invalid == 1
    assert m.out_of_scope == 1
    assert m.repeat == 1
    assert m.unknown_tool == 1
    assert m.adapter_error == 1
    assert m.success_rate == 1 / 7
    # model faults = malformed + schema_invalid + unknown_tool = 3
    assert m.well_formed_rate == (7 - 3) / 7


def test_tool_call_metrics_empty_stream():
    m = tool_call_metrics([])
    assert m.attempts == 0
    assert m.success_rate == 0.0
    assert m.well_formed_rate == 0.0


# --- solutions -------------------------------------------------------------

def test_match_found_exploited_and_false_positive():
    solutions = load_spec()  # the shipped Juice Shop spec
    findings = [
        {
            "id": "F-001",
            "title": "UNION SQLi on /rest/products/search",
            "severity": "critical",
            "evidence": "dumped sqlite_master schema via UNION SELECT",
            "repro": "q=')) UNION SELECT ...",
        },
        {
            "id": "F-002",
            "title": "Server responds to GET /",
            "severity": "info",
            "evidence": "200 OK",
            "repro": "curl /",
        },
    ]
    outcomes, false_positives = match(findings, solutions)

    sqli = next(o for o in outcomes if o.solution.id == "sqli-search")
    assert sqli.found is True
    assert sqli.exploited is True
    assert "F-001" in sqli.matched_finding_ids

    # The benign finding matches no solution → flagged as a candidate FP.
    assert [f["id"] for f in false_positives] == ["F-002"]


def test_match_found_but_not_exploited():
    solutions = load_spec()
    findings = [
        {
            "id": "F-001",
            "title": "Possible SQL injection in product search",
            "severity": "high",
            "evidence": "error message leaked on quote",
            "repro": "q='",
        }
    ]
    outcomes, _ = match(findings, solutions)
    sqli = next(o for o in outcomes if o.solution.id == "sqli-search")
    assert sqli.found is True
    assert sqli.exploited is False  # flagged, not proven (§8 distinction)


# --- score -----------------------------------------------------------------

def _artifacts(tmp_path: Path) -> RunArtifacts:
    events = [
        _tool_result(False),
        _tool_result(True, "invalid arguments for http_request: url required"),
        {"ts": "2026-08-08T00:00:05+00:00", "type": "cost", "data": {"tokens": 100}},
    ]
    report = {
        "completed": False,
        "halt_reason": "tool-call cap reached (25/25)",
        "turns": 12,
        "tool_results": 10,
        "budget": {"tokens": 49006, "usd": 0.0021, "tool_calls": 25},
    }
    findings = [
        {
            "id": "F-001",
            "title": "UNION SQLi on /rest/products/search",
            "severity": "critical",
            "evidence": "dumped sqlite_master via UNION SELECT",
            "repro": "q=')) UNION SELECT ...",
        }
    ]
    return RunArtifacts(run_dir=tmp_path, events=events, report=report, findings=findings)


def test_score_artifacts_assembles_scorecard(tmp_path):
    card = score_artifacts(_artifacts(tmp_path))

    assert card.completed is False
    assert card.halt_reason.startswith("tool-call cap")
    assert card.found_count >= 1
    assert card.exploited_count >= 1
    assert card.tokens == 49006
    assert card.usd == 0.0021
    assert card.tool_calls == 25
    assert card.tool_call.attempts == 2
    assert card.tool_call.executed == 1
    d = card.to_dict()
    assert d["coverage"]["found"] == card.found_count
    assert d["tool_call"]["success_rate"] == 0.5


def _write_run_dir(tmp_path: Path) -> Path:
    """Persist synthetic artifacts to disk so score_run/sweep can load them."""
    run_dir = tmp_path / "20260808T000000Z"
    run_dir.mkdir()
    arts = _artifacts(run_dir)
    (run_dir / "events.jsonl").write_text(
        "\n".join(json.dumps(e) for e in arts.events), encoding="utf-8"
    )
    (run_dir / "report.json").write_text(json.dumps(arts.report), encoding="utf-8")
    (run_dir / "findings.jsonl").write_text(
        "\n".join(json.dumps(f) for f in arts.findings), encoding="utf-8"
    )
    return run_dir


def test_load_run_and_score_run_from_disk(tmp_path):
    run_dir = _write_run_dir(tmp_path)
    loaded = load_run(run_dir)
    assert len(loaded.findings) == 1
    assert loaded.wall_time_seconds() == 5.0

    card = score_run(run_dir)
    assert card.exploited_count >= 1
    assert card.tool_call.attempts == 2


# --- sweep -----------------------------------------------------------------

def test_sweep_scores_each_model_and_picks_primary(tmp_path):
    run_dir = _write_run_dir(tmp_path)

    def fake_run_fn(model_id: str, base_config: Path) -> Path:
        return run_dir  # same synthetic run for both models

    result = sweep(
        Path("unused.toml"),
        models=("deepseek/deepseek-v4-flash", "moonshotai/kimi-k2"),
        run_fn=fake_run_fn,
    )

    assert len(result.cards) == 2
    # The sweep fills the model the driver didn't stamp into the stream.
    assert {c.model for c in result.cards} == {
        "deepseek/deepseek-v4-flash",
        "moonshotai/kimi-k2",
    }
    assert result.primary in {"deepseek/deepseek-v4-flash", "moonshotai/kimi-k2"}
    assert "exploited" in result.rationale


def test_recommend_primary_prefers_more_exploits(tmp_path):
    run_dir = _write_run_dir(tmp_path)
    strong = score_run(run_dir)  # exploits 1
    from dataclasses import replace

    weak = replace(
        score_run(run_dir),
        model="weak/model",
        exploited_count=0,
        found_count=0,
    )
    strong = replace(strong, model="strong/model")

    primary, _ = recommend_primary([weak, strong])
    assert primary == "strong/model"
