"""store — the on-disk ledger (docs/harness.md §5).

Owns the run directory and the three stores:
  - findings      structured list (note_finding writes here). The scored artifact.
  - tool outputs  raw, addressable by id — truncated in-context, full on disk.
  - attempt log   what-was-tried (attempt_log.py), opened alongside for the loop guard.

Read by driver/report.py and eval/score.py — the same artifacts the dashboard
would read (§8). Persistence layout only; dedup logic is attempt_log.py, context
folding is context.py.

Layout under the run directory:
    findings.jsonl        one finding per line (add_finding appends)
    attempts.jsonl        one attempted call per line (AttemptLog)
    outputs/<id>.txt       full tool output, addressable by call id
"""

from __future__ import annotations

import json
from pathlib import Path

from autosploit_harness.contracts.results import FindingId
from autosploit_harness.ledger.attempt_log import AttemptLog


class Ledger:
    """On-disk engagement store: findings + tool outputs + attempt log.

    Survives the run and is the report source (§5). One per run, rooted at the
    run directory the driver creates.
    """

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        run_dir.mkdir(parents=True, exist_ok=True)
        self._findings_path = run_dir / "findings.jsonl"
        self._outputs_dir = run_dir / "outputs"
        self._outputs_dir.mkdir(exist_ok=True)
        self.attempts = AttemptLog(run_dir / "attempts.jsonl")
        # Monotonic finding counter, seeded from any findings already on disk.
        self._finding_seq = len(self.findings())

    # --- findings (the scored artifact) -------------------------------------

    def add_finding(self, title: str, severity: str, evidence: str, repro: str) -> FindingId:
        """Append a structured finding, return its handle (§5). note_finding's sink."""
        self._finding_seq += 1
        fid = f"F-{self._finding_seq:03d}"
        row = {
            "id": fid,
            "title": title,
            "severity": severity,
            "evidence": evidence,
            "repro": repro,
        }
        with self._findings_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        return FindingId(id=fid, title=title, severity=severity)

    def findings(self) -> list[dict]:
        """Every recorded finding, in order — the report's scored list (§8)."""
        if not self._findings_path.exists():
            return []
        rows: list[dict] = []
        for raw in self._findings_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line:
                rows.append(json.loads(line))
        return rows

    # --- tool outputs (addressable by call id) ------------------------------

    def write_output(self, call_id: str, name: str, content: str) -> Path:
        """Persist a tool's output under the call id; return the file path.

        The full record on disk; the transcript keeps a truncated preview
        (tools/truncate.py). `run_shell cat <path>` can recover the rest (§4).
        """
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(call_id or "anon"))
        path = self._outputs_dir / f"{safe}.txt"
        path.write_text(f"# {name} ({call_id})\n{content}", encoding="utf-8")
        return path
