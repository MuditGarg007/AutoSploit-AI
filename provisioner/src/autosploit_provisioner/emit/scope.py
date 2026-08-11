"""scope — write + self-validate scope.yaml (docs/provisioner.md §4 row 5, §3, M5).

`emit_scope(host, ports, out)` writes `target: {host, ports}` in the exact shape
the harness reads, then **self-validates by calling the harness `load_scope` on the
file it just wrote** and asserting the returned `ScopeAllowlist.ports` (and host)
equal what was passed. Any mismatch — or the harness parser raising — aborts before
handoff (`ScopeValidationFailed`, fail-closed, §3), and the bad file is unlinked so
no stale/unparseable scope is left for the conductor to pick up.

This is the single load-bearing assertion of the component: the harness's own
parser is the acceptance test for the file (§11 "non-negotiable").
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import yaml
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.driver.config import load_scope

from ..contracts.errors import ScopeValidationFailed


def emit_scope(host: str, ports: Sequence[int], out: Path) -> Path:
    """Write the frozen scope to `out`, self-validate via harness `load_scope`, return `out`.

    Raises `ScopeValidationFailed` if `ports` is empty, or if the written file does
    not round-trip through `load_scope` to the same host + ports (fail-closed, §3).
    """
    coerced = tuple(int(p) for p in ports)
    if not coerced:
        # Empty ports would be a target with nothing to attack — reject before writing
        # (mirrors the harness, which rejects an empty ports list; §3 fail-closed).
        raise ScopeValidationFailed("refusing to emit scope with empty ports")

    expected = ScopeAllowlist(host=str(host), ports=coerced)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        yaml.safe_dump(
            {"target": {"host": str(host), "ports": list(coerced)}},
            default_flow_style=False,
            sort_keys=False,
        ),
        encoding="utf-8",
    )

    # The seam: parse the file back through the exact function the harness uses. If
    # it raises or returns a different allowlist, the scope is unusable → abort.
    try:
        parsed = load_scope(out)
    except Exception as err:  # any parse failure means the scope is bad → abort
        out.unlink(missing_ok=True)
        raise ScopeValidationFailed(
            f"emitted scope {out} failed to parse through harness load_scope: {err}"
        ) from err

    if parsed != expected:
        out.unlink(missing_ok=True)
        raise ScopeValidationFailed(
            f"emitted scope {out} round-tripped to {parsed}, expected {expected}"
        )
    return out
