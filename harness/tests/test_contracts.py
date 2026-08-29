"""Contract tests (docs/harness.md §9 step 5) — the freeze is only real if drift fails here.

Three guards:
  1. DRIFT — the committed contracts/contract.schema.json matches what the live
     shapes generate. Change a seam (event payload, scope/config format, driver or
     report signature) without regenerating the golden + moving CONTRACT_VERSION,
     and this fails. Regenerate on purpose with `autosploit-harness contract`.
  2. COVERAGE — every EventType has a payload shape, and validate_event enforces
     each shape's required keys (fail-closed on unknown type / missing key).
  3. CONFORMANCE — a real emitted event stream (the smoke graph) validates against
     the frozen payloads, so the descriptor describes what the harness actually emits.
"""

from __future__ import annotations

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from autosploit_harness.budget.state import BudgetState
from autosploit_harness.contracts.events import (
    EVENT_PAYLOADS,
    EventType,
    make_event,
    validate_event,
)
from autosploit_harness.contracts.export import DEFAULT_CONTRACT_PATH, to_json
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.contracts.version import CONTRACT_VERSION
from autosploit_harness.driver.config import load_scope
from autosploit_harness.driver.run import run_engagement
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.ledger.store import Ledger

SCOPE = ScopeAllowlist(host="127.0.0.1", ports=(3000,))

# One minimal VALID payload per event type — the required keys, nothing extra.
_MINIMAL: dict[EventType, dict] = {
    "phase": {"stage": "recon"},
    "tool_call": {"name": "run_shell", "id": "c1"},
    "tool_result": {"id": "c1", "name": "run_shell", "is_error": False},
    "finding": {"id": "F-001", "title": "t", "severity": "high", "evidence": "e", "repro": "r"},
    "cost": {"tokens": 0, "usd": 0.0, "tool_calls": 0, "caps": {}},
    "refusal": {"reason": "policy"},
    "halt": {},  # halt has no invariant key
}


# --- 1. DRIFT ---------------------------------------------------------------

def test_committed_contract_matches_live_shapes():
    """The golden descriptor is regenerated from code and must match on disk.

    If this fails you changed a seam. Regenerate: `autosploit-harness contract`,
    and move CONTRACT_VERSION (docs/harness.md §9 step 5) to signal the change.
    """
    assert DEFAULT_CONTRACT_PATH.exists(), "run `autosploit-harness contract` to write the golden"
    on_disk = DEFAULT_CONTRACT_PATH.read_text(encoding="utf-8")
    assert on_disk == to_json(), "contract drift — regenerate the golden and bump CONTRACT_VERSION"


def test_contract_version_is_semver():
    parts = CONTRACT_VERSION.split(".")
    assert len(parts) == 3 and all(p.isdigit() for p in parts)


# --- 2. COVERAGE ------------------------------------------------------------

def test_every_event_type_has_a_payload():
    assert set(EVENT_PAYLOADS) == set(EventType.__args__)


@pytest.mark.parametrize("etype", list(EVENT_PAYLOADS))
def test_minimal_payload_validates(etype):
    validate_event(make_event(etype, dict(_MINIMAL[etype])))


def test_unknown_type_is_rejected():
    with pytest.raises(ValueError, match="unknown event type"):
        validate_event({"ts": "t", "type": "not_a_type", "data": {}})  # type: ignore[typeddict-item]


def test_missing_required_key_is_rejected():
    # finding without severity — a required key drops out → fail-closed.
    bad = {k: v for k, v in _MINIMAL["finding"].items() if k != "severity"}
    with pytest.raises(ValueError, match="missing required key"):
        validate_event(make_event("finding", bad))


def test_non_mapping_data_is_rejected():
    with pytest.raises(ValueError, match="must be a mapping"):
        validate_event({"ts": "t", "type": "phase", "data": ["not", "a", "dict"]})  # type: ignore[typeddict-item]


# --- 3. CONFORMANCE ---------------------------------------------------------

def test_emitted_stream_conforms_to_frozen_payloads(tmp_path):
    """Every event a real run emits validates against the frozen payload shapes."""
    model = FakeMessagesListChatModel(responses=[
        AIMessage(
            content="probe",
            tool_calls=[{"name": "run_shell", "args": {"cmd": "echo ok", "timeout": 5}, "id": "c1"}],
        ),
        AIMessage(
            content="record",
            tool_calls=[{
                "name": "note_finding",
                "args": {"title": "x", "severity": "high", "evidence": "e", "repro": "r"},
                "id": "f1",
            }],
        ),
        AIMessage(
            content="done",
            tool_calls=[{"name": "engagement_complete", "args": {"summary": "s"}, "id": "z"}],
        ),
    ])
    emitter = JsonlEmitter(path=None, stdout=False)
    run_engagement(
        model=model, scope=SCOPE, budget=BudgetState(max_tool_calls=60),
        emitter=emitter, ledger=Ledger(tmp_path),
    )

    emitted = {e["type"] for e in emitter.events}
    assert {"phase", "tool_call", "tool_result", "finding", "cost"} <= emitted
    for event in emitter.events:
        validate_event(event)  # raises on any drift from the frozen shape


# --- scope-file format seam -------------------------------------------------

def test_scope_file_round_trips(tmp_path):
    """The frozen scope-file format loads into ScopeAllowlist unchanged."""
    scope_yaml = tmp_path / "scope.yaml"
    scope_yaml.write_text("target:\n  host: 127.0.0.1\n  ports: [3000, 8080]\n", encoding="utf-8")
    scope = load_scope(scope_yaml)
    assert scope.host == "127.0.0.1"
    assert scope.ports == (3000, 8080)
    assert scope.allows("127.0.0.1", 8080) and not scope.allows("127.0.0.1", 22)
