"""note_finding — structured finding adapter (docs/harness.md §4, §5).

    note_finding(title, severity, evidence, repro) -> FindingId

Writes a structured finding to the ledger and emits a finding event. Not a
command — the scored artifact of the whole engagement (§5, §8). Findings live on
disk, so transcript summarization can never lose one (§5).

The adapter needs the ledger (to persist) and the emitter (to fire the `finding`
event). Both are bound by registry.build_callables() at graph-build time — the
model only ever sees the four typed args, never the injected deps.
"""

from __future__ import annotations

from autosploit_harness.contracts.results import FindingId
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.ledger.store import Ledger

VALID_SEVERITIES = ("info", "low", "medium", "high", "critical")


def note_finding(
    *,
    ledger: Ledger,
    emitter: JsonlEmitter,
    title: str,
    severity: str,
    evidence: str,
    repro: str,
) -> FindingId:
    """Persist a finding to the ledger, emit a `finding` event, return its id.

    Severity is normalized to the known scale; an unknown value falls back to
    "info" rather than being rejected — a recorded finding beats a lost one.
    """
    sev = severity.strip().lower()
    if sev not in VALID_SEVERITIES:
        sev = "info"
    handle = ledger.add_finding(title=title, severity=sev, evidence=evidence, repro=repro)
    emitter.emit(
        "finding",
        {
            "id": handle.id,
            "title": title,
            "severity": sev,
            "evidence": evidence,
            "repro": repro,
        },
    )
    return handle
