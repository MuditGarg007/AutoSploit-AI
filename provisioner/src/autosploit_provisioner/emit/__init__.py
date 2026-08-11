"""emit — write the frozen scope + the manifest (docs/provisioner.md §4 rows 5-6).

`scope` writes `target: {host, ports}` in the exact shape the harness reads, then
**self-validates by calling the harness `load_scope` on it** — fail-closed if it
does not parse (§3, the load-bearing seam). `manifest` records `provision.json`
for debug + teardown. Neither ever writes the clone token (§8).
"""

from __future__ import annotations

from .manifest import write_manifest
from .scope import emit_scope

__all__ = ["emit_scope", "write_manifest"]
