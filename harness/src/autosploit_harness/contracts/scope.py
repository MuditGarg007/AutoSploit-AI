"""ScopeAllowlist — the immutable scope shape (docs/harness.md §2, §3).

A frozen dataclass: target host(s) + allowed ports. Written once by the driver
before the graph starts and never mutated — the immutability is enforced by the
type (frozen), not by trusting the loop. Standalone it's loaded from a hardcoded
YAML (configs/scope.*.yaml) that fakes what the provisioner emits later; the
format is a frozen seam (§9), so the provisioner drops in without reshaping it.

The interceptor (§3) reads this to allow/deny http_request targets. Shell scope
is NOT decided here — that's the sandbox firewall's job (§3).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ScopeAllowlist:
    """Immutable target allowlist. Constructed once by the driver, never mutated."""

    host: str
    ports: tuple[int, ...]

    def allows(self, host: str, port: int) -> bool:
        """True iff host+port are inside scope. Skeleton: exact host match.

        http_request scope-checks through here (§3). run_shell does NOT — its
        network boundary is the sandbox firewall, not this list.
        """
        return host == self.host and port in self.ports
