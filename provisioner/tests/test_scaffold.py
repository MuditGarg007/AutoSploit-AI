"""M0 gate (docs/provisioner.md §11 M0): scaffold + the frozen seam import.

The one thing that cannot be faked later — the path dep on the harness and the
ability to import the exact `load_scope` the emitted scope will be validated
against (§3). If this fails, nothing downstream can hold the contract.
"""

from __future__ import annotations


def test_harness_seam_imports() -> None:
    """The frozen seam resolves through the path dep on ../harness."""
    from autosploit_harness.contracts.scope import ScopeAllowlist
    from autosploit_harness.driver.config import load_scope

    assert callable(load_scope)
    # The shape the provisioner targets: single host + a tuple of int ports.
    allow = ScopeAllowlist(host="127.0.0.1", ports=(3000,))
    assert allow.allows("127.0.0.1", 3000)
    assert not allow.allows("127.0.0.1", 9999)


def test_provisioner_package_imports() -> None:
    """Every slice package + the contracts seam import cleanly (scaffold intact)."""
    import autosploit_provisioner  # noqa: F401
    from autosploit_provisioner.contracts import errors, plan, result

    # Error root is in place for slices to raise through (§8).
    assert issubclass(errors.UnsupportedBuild, errors.ProvisionError)
    # Frozen contracts are constructible.
    assert plan.BuildBranch is not None
    assert result.ProvisionResult.__dataclass_params__.frozen
