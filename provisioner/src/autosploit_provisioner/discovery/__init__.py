"""discovery — health poll + published-port inspect (docs/provisioner.md §4 row 4).

Poll the container to ready (running + at least one bound port; honor a declared
healthcheck if present), then read the published HOST ports from
`NetworkSettings.Ports`. Reject if the container exits or exposes nothing to
attack (NoPortsExposed). Phase A does not wait on app-level readiness (§9).
"""

from __future__ import annotations

from .ports import Ports, discover

__all__ = ["Ports", "discover"]
