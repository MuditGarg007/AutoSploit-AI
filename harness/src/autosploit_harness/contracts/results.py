"""Tool result shapes (docs/harness.md §4) — structured returns for each adapter.

    ShellResult   stdout + stderr + exit code, truncated (run_shell)
    HttpResult    status + headers + body, truncated (http_request)
    FindingId     handle returned by note_finding into the ledger

Every typed tool returns one of these, never a raw blob — so the interceptor,
the ledger, and the event stream all read structured fields, not text. Overflow
handling (full output → ledger, preview + id in-context) is tools/truncate.py;
this file only defines the shapes.

Step 2 (§9) adds HttpResult (http_request), FindingId (note_finding), and
CompleteResult (engagement_complete) — the full tool surface's returns.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class ShellResult:
    """Structured return of run_shell: stdout + stderr + exit code, truncated."""

    cmd: str
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool = False
    timed_out: bool = False


@dataclass(frozen=True, slots=True)
class HttpResult:
    """Structured return of http_request: status + headers + body, truncated.

    `url` is the interceptable field the scope check reads (§3). `error` is set
    when the request never completed (DNS/connect/timeout) — a result the agent
    reads, not an exception that crashes the loop.
    """

    method: str
    url: str
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: str = ""
    truncated: bool = False
    error: str | None = None


@dataclass(frozen=True, slots=True)
class FindingId:
    """Handle note_finding returns after writing a finding to the ledger (§5).

    Carries the ledger id back into the transcript so the agent can reference the
    finding it just recorded; the full record lives on disk.
    """

    id: str
    title: str
    severity: str


@dataclass(frozen=True, slots=True)
class CompleteResult:
    """Return of engagement_complete — the agent's done signal (§4, §5).

    The graph routes this to END → full report; the summary rides to the report.
    """

    summary: str
