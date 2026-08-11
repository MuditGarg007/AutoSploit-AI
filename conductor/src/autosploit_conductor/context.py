"""Run context — engagement out-dir + engagement-id validation (docs/conductor.md §7 [1]).

Pure, no subprocess (build order C1): mkdir the engagement out-dir and validate
the engagement id against the Docker label charset before it is ever used as a
label or a dir name (§8, "Engagement-id safety").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# Docker label charset (§8): `[a-zA-Z0-9_.-]`, non-empty. No injection through
# an id into subprocess args — the id only ever leaves this process as an argv
# element or a filesystem name.
_ENGAGEMENT_ID_RE = re.compile(r"^[a-zA-Z0-9_.-]+$")


class ConductorError(Exception):
    """Base error for the conductor — one root the CLI catches cleanly (C1)."""


class ContextError(ConductorError):
    """Invalid engagement context (bad id or unresolvable out-dir)."""


@dataclass(frozen=True, slots=True)
class EngagementContext:
    """Validated per-run context (docs/conductor.md §7 [1])."""

    engagement_id: str
    out_dir: Path
    repo_ref: str
    timeout_s: float


def validate_engagement_id(engagement_id: str) -> None:
    """Raise ContextError unless the id is a valid Docker label / dir name."""
    if not isinstance(engagement_id, str) or not engagement_id:
        raise ContextError(f"engagement id must be non-empty: {engagement_id!r}")
    if not _ENGAGEMENT_ID_RE.fullmatch(engagement_id):
        raise ContextError(
            f"engagement id {engagement_id!r} must match the docker label charset "
            r"[a-zA-Z0-9_.-]+"
        )


def make_context(
    repo_ref: str,
    engagement_id: str | None,
    out_dir: Path | str = ".",
    timeout_s: float = 3600.0,
) -> EngagementContext:
    """Build the engagement context: mkdir the out-dir, validate the id (C1).

    When `engagement_id` is None a fresh one is generated — an id that passes
    the same validation so it is always safe as a label and a dir name.
    """
    if engagement_id is None:
        import uuid

        engagement_id = uuid.uuid4().hex
    validate_engagement_id(engagement_id)

    out = Path(out_dir) / engagement_id
    out.mkdir(parents=True, exist_ok=True)

    return EngagementContext(
        engagement_id=engagement_id,
        out_dir=out,
        repo_ref=repo_ref,
        timeout_s=timeout_s,
    )
