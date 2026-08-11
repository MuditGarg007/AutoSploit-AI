"""errors — the exception root every slice raises through (docs/provisioner.md §8).

One root (`ProvisionError`) so the CLI and the conductor can catch the whole
component cleanly. The subclasses map 1:1 onto the §8 reject paths, so a caller
can tell an unsupported repo (user's fault, clear message) from a boot failure
(target's fault, log tail attached) without string-matching.
"""

from __future__ import annotations


class ProvisionError(Exception):
    """Base for every failure the provisioner surfaces. Never leaks a token (§8)."""


class UnsupportedBuild(ProvisionError):
    """No usable build branch: missing Dockerfile, or compose-only (deferred, §9)."""


class BuildFailed(ProvisionError):
    """`docker build` failed. Carries a log tail; no partial container left (§8)."""


class BootTimeout(ProvisionError):
    """Container never reached ready before timeout. Carries a container-log tail (§8)."""


class NoPortsExposed(ProvisionError):
    """Container published no ports — nothing to attack, reject (§8)."""


class ScopeValidationFailed(ProvisionError):
    """Emitted scope did not round-trip through the harness `load_scope` (§3).

    Raised by the scope emitter when the file it wrote fails to parse, or parses
    to different ports/host than were passed. Fail-closed: never hand the harness
    an unparseable or wrong scope (§3, the load-bearing seam)."""
