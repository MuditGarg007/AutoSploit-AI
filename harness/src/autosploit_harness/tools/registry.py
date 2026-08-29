"""registry — tool binding + strict schemas (docs/harness.md §4, §6.1.1).

Collects the typed tools and exposes them for LangGraph to bind to the model,
each with a strict argument schema. The schema is what the interceptor validates
against before execution (§6.1.1) — defined once here, enforced at the gate.
Also maps tool name → adapter callable for the tool node. No execution logic;
the adapters live in their own modules.

Step 2 (§9) registers the full surface: run_shell, http_request, note_finding,
engagement_complete. note_finding needs the ledger + emitter, so callables are
built per-run by build_callables() with those deps bound; the model never sees
them. engagement_complete is terminal — bound for the model, but routed to END
by the graph rather than executed through the tool node.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict
from functools import partial
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from autosploit_harness.contracts.results import (
    CompleteResult,
    FindingId,
    HttpResult,
    ShellResult,
)
from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.ledger.store import Ledger
from autosploit_harness.tools.http_request import DEFAULT_TIMEOUT as HTTP_TIMEOUT
from autosploit_harness.tools.http_request import http_request
from autosploit_harness.tools.note_finding import note_finding
from autosploit_harness.tools.run_shell import DEFAULT_TIMEOUT as SHELL_TIMEOUT
from autosploit_harness.tools.run_shell import run_shell
from autosploit_harness.tools.truncate import truncate

# --- strict arg schemas (interceptor validation, §6.1.1) --------------------

class RunShellArgs(BaseModel):
    """Strict schema for run_shell — what the interceptor validates against."""

    cmd: str = Field(description="Shell command to run in the attacker container.")
    timeout: int = Field(
        default=SHELL_TIMEOUT, description="Seconds before the command is killed.", ge=1
    )


class HttpRequestArgs(BaseModel):
    """Strict schema for http_request. `url` is the interceptable field (§3)."""

    method: str = Field(default="GET", description="HTTP method (GET, POST, ...).")
    url: str = Field(description="Absolute URL. Host+port are scope-checked (§3).")
    headers: dict[str, str] | None = Field(
        default=None, description="Optional request headers."
    )
    body: str | None = Field(default=None, description="Optional request body.")
    timeout: int = Field(
        default=HTTP_TIMEOUT, description="Seconds before the request is aborted.", ge=1
    )


class NoteFindingArgs(BaseModel):
    """Strict schema for note_finding — the scored artifact's input (§5)."""

    title: str = Field(description="Short finding title.")
    severity: str = Field(description="info | low | medium | high | critical.")
    evidence: str = Field(description="Concrete proof (request/response, output).")
    repro: str = Field(description="Steps to reproduce the finding.")


class EngagementCompleteArgs(BaseModel):
    """Strict schema for engagement_complete — the agent's done signal (§4)."""

    summary: str = Field(description="Summary of what was found and exploited.")


# name → the pydantic args schema (interceptor validation, §6.1.1).
SCHEMAS: dict[str, type[BaseModel]] = {
    "run_shell": RunShellArgs,
    "http_request": HttpRequestArgs,
    "note_finding": NoteFindingArgs,
    "engagement_complete": EngagementCompleteArgs,
}


def _not_executed_here(*_a: Any, **_k: Any) -> Any:
    """Spec-only placeholder. Tools execute through CALLABLES in the tool node,
    never via the StructuredTool spec — the spec exists to bind name + schema to
    the model. Invocation here is a wiring bug."""
    raise RuntimeError("tool spec is bind-only; execute via the tool node")


def _spec(name: str, description: str, schema: type[BaseModel]) -> StructuredTool:
    return StructuredTool(
        name=name,
        description=description,
        args_schema=schema,
        func=_not_executed_here,
    )


_SPECS = [
    _spec(
        "run_shell",
        "Run a shell command in the attacker container (nmap, curl, sqlmap, nikto, "
        "ffuf, ...). Returns stdout, stderr, and the exit code.",
        RunShellArgs,
    ),
    _spec(
        "http_request",
        "Issue a single structured HTTP request to an in-scope target. Returns "
        "status, headers, and body. Redirects are not followed.",
        HttpRequestArgs,
    ),
    _spec(
        "note_finding",
        "Record a confirmed vulnerability as a structured finding (title, "
        "severity, evidence, repro). This is the scored output of the engagement.",
        NoteFindingArgs,
    ),
    _spec(
        "engagement_complete",
        "Signal the engagement is finished and hand back a summary. Ends the run.",
        EngagementCompleteArgs,
    ),
]


def tool_specs() -> list[StructuredTool]:
    """The tools LangGraph binds to the model (gateway/, §6). The full surface."""
    return list(_SPECS)


def build_callables(
    ledger: Ledger, emitter: JsonlEmitter
) -> dict[str, Callable[..., Any]]:
    """name → executable adapter, with per-run deps bound (§4).

    note_finding gets the ledger + emitter bound here; the model never sees them.
    engagement_complete is intentionally absent — it is terminal and handled by
    the graph's complete node, not executed through the tool node.
    """
    return {
        "run_shell": run_shell,
        "http_request": http_request,
        "note_finding": partial(note_finding, ledger=ledger, emitter=emitter),
    }


# Terminal tools the tool node must never execute (routed to END instead).
TERMINAL_TOOLS = frozenset({"engagement_complete"})


def render_result(result: Any) -> str:
    """Flatten a structured tool result into ToolMessage content for the transcript."""
    if isinstance(result, ShellResult):
        parts = [f"$ {result.cmd}", f"exit={result.exit_code}"]
        if result.timed_out:
            parts.append("(timed out)")
        if result.stdout:
            parts.append(f"--- stdout ---\n{result.stdout}")
        if result.stderr:
            parts.append(f"--- stderr ---\n{result.stderr}")
        return "\n".join(parts)
    if isinstance(result, HttpResult):
        if result.error:
            return f"{result.method} {result.url}\nrequest failed: {result.error}"
        header_lines = "\n".join(f"{k}: {v}" for k, v in result.headers.items())
        return (
            f"{result.method} {result.url} → {result.status}\n"
            f"--- headers ---\n{header_lines}\n--- body ---\n{result.body}"
        )
    if isinstance(result, FindingId):
        return f"finding recorded: {result.id} [{result.severity}] {result.title}"
    if isinstance(result, CompleteResult):
        return f"engagement complete: {result.summary}"
    return str(result)


def event_payload(result: Any) -> dict:
    """Structured payload for the tool_result event (contracts/events.py).

    The full output lives in the ledger (tool_node spills it, §5); the event keeps
    the same structured shape but caps the long text fields (stdout/stderr/body) so
    the JSONL stream stays bounded even when a scan dumps megabytes.
    """
    if isinstance(result, ShellResult | HttpResult | FindingId | CompleteResult):
        data = asdict(result)
        for key in ("stdout", "stderr", "body"):
            val = data.get(key)
            if isinstance(val, str) and val:
                capped, cut = truncate(val)
                data[key] = capped
                if cut:
                    data["truncated"] = True
        return data
    return {"result": str(result)}
