"""Scope-check tests (docs/harness.md §3).

  - http_request url in allowlist → allow; wrong host/port → deny.
  - malformed / missing url → raise → gate denies (fail-closed).
  - run_shell is NOT scope-checked here — asserts the interceptor leaves shell
    scope to the network layer (only budget-gates + logs it, §3).

Step 2 (§9): url-parsing scope decisions for http_request land in
interceptor/scope_check.out_of_scope — covered below alongside the ScopeAllowlist
decision itself (the frozen shape the url check calls into).
"""

from __future__ import annotations

from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.interceptor.scope_check import out_of_scope

SCOPE = ScopeAllowlist(host="127.0.0.1", ports=(3000,))


def test_allows_in_scope_host_and_port():
    assert SCOPE.allows("127.0.0.1", 3000) is True


def test_denies_wrong_port():
    assert SCOPE.allows("127.0.0.1", 8080) is False


def test_denies_wrong_host():
    assert SCOPE.allows("10.0.0.5", 3000) is False


def test_scope_is_frozen():
    """Immutability is enforced by the type, not by trusting the loop (§3)."""
    import dataclasses

    try:
        SCOPE.host = "evil.example"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("ScopeAllowlist must be frozen")


# --- http_request url scope decisions (step 2) ------------------------------

def test_http_in_scope_url_allowed():
    assert out_of_scope("http_request", {"url": "http://127.0.0.1:3000/rest"}, SCOPE) is None


def test_http_out_of_scope_host_denied():
    reason = out_of_scope("http_request", {"url": "http://evil.example:3000/"}, SCOPE)
    assert reason is not None and "out of scope" in reason


def test_http_out_of_scope_port_denied():
    reason = out_of_scope("http_request", {"url": "http://127.0.0.1:8080/"}, SCOPE)
    assert reason is not None and "out of scope" in reason


def test_http_default_port_from_scheme():
    """No explicit port → derive from scheme; http→80 is out of a 3000-only scope."""
    reason = out_of_scope("http_request", {"url": "http://127.0.0.1/"}, SCOPE)
    assert reason is not None  # port 80 not in the allowlist


def test_http_missing_url_denied_fail_closed():
    reason = out_of_scope("http_request", {"method": "GET"}, SCOPE)
    assert reason is not None and "url" in reason


def test_run_shell_not_scope_checked():
    """Shell scope is the network layer's job — the check waves it through (§3)."""
    assert out_of_scope("run_shell", {"cmd": "curl evil.example"}, SCOPE) is None
