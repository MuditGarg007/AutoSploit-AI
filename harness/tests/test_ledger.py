"""Ledger tests (docs/harness.md §5) — the on-disk store is the report source.

Covers: findings persist + read back (the scored artifact), tool outputs are
addressable by call id, and the attempt log dedupes on name+args (the loop
guard's data, §6.1.3). All backed by real files under a tmp run dir.
"""

from __future__ import annotations

from autosploit_harness.ledger.store import Ledger


def test_findings_persist_and_read_back(tmp_path):
    ledger = Ledger(tmp_path)
    handle = ledger.add_finding(
        title="XSS in search", severity="high", evidence="<script>", repro="q=<script>"
    )
    assert handle.id == "F-001"

    rows = ledger.findings()
    assert len(rows) == 1
    assert rows[0]["title"] == "XSS in search"
    assert rows[0]["severity"] == "high"

    # A fresh handle over the same dir keeps counting, doesn't reset.
    assert Ledger(tmp_path).add_finding("second", "low", "e", "r").id == "F-002"


def test_output_addressable_by_call_id(tmp_path):
    ledger = Ledger(tmp_path)
    path = ledger.write_output("c1", "run_shell", "big scan output")
    assert path.exists()
    assert "big scan output" in path.read_text(encoding="utf-8")


def test_attempt_log_dedupes_on_name_and_args(tmp_path):
    ledger = Ledger(tmp_path)
    args = {"cmd": "nmap -sV 127.0.0.1", "timeout": 60}
    assert ledger.attempts.seen("run_shell", args) is False

    ledger.attempts.record("run_shell", args, result="open: 3000")
    assert ledger.attempts.seen("run_shell", args) is True
    # Arg order does not matter — fingerprint is canonical.
    assert ledger.attempts.seen("run_shell", {"timeout": 60, "cmd": "nmap -sV 127.0.0.1"}) is True
    # Different args are a different attempt.
    assert ledger.attempts.seen("run_shell", {"cmd": "whoami", "timeout": 60}) is False

    # Persisted across a re-open.
    assert Ledger(tmp_path).attempts.seen("run_shell", args) is True
