"""result — the provisioner's output shape (docs/provisioner.md §4 rows 5-6, §5 handoff).

`ProvisionResult` is what `provision.py` returns and the conductor consumes: the
path to the frozen scope (already self-validated via the harness `load_scope`, §3),
the manifest path, the discovered host ports, and the container id(s) for teardown.
Frozen — built once at the end of a successful provision, never mutated.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ProvisionResult:
    """Result of a successful provision (docs/provisioner.md §5 HANDOFF)."""

    engagement_id: str
    scope_path: Path
    manifest_path: Path
    host: str
    ports: tuple[int, ...]
    container_ids: tuple[str, ...]
