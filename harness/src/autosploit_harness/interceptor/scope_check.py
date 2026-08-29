"""scope_check — target-in-scope decision (docs/harness.md §3).

  - http_request(url=...): parse the url field (structured, no shell parsing),
    check host + port against the ScopeAllowlist. Clean and decidable.
  - run_shell(cmd=...): NOT parsed for scope. Shell can't escape the network —
    the real boundary is the sandbox firewall (default-deny egress, allowlist
    target only, overview.md §4.1; standalone = docker network rules). The
    interceptor still budget-gates and logs shell, but scope for shell is the
    network layer's job, exactly as in production.

Two layers, neither is the LLM. This split is the whole reason http_request
exists as a typed tool (§3). Parse failure / missing field → deny (fail-closed):
returns a reason string the gate turns into a corrective tool_result.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from autosploit_harness.contracts.scope import ScopeAllowlist

_DEFAULT_PORT = {"http": 80, "https": 443}


def out_of_scope(name: str, args: dict[str, Any], scope: ScopeAllowlist) -> str | None:
    """Return a deny reason if the call's target is out of scope, else None.

    None = allowed (in scope, or not a scope-checked tool). A non-None string is
    the reason the gate returns to the agent. Fail-closed: an unparseable or
    missing url denies rather than defaulting to allow (§3).
    """
    # Only http_request carries a structured, interceptable target. run_shell and
    # everything else route their scope to the network layer, not this check (§3).
    if name != "http_request":
        return None

    url = (args or {}).get("url")
    if not url or not isinstance(url, str):
        return "http_request: a string 'url' is required for the scope check"

    parsed = urlparse(url)
    host = parsed.hostname
    if host is None:
        return f"http_request: could not parse a host from url {url!r}"

    scheme = (parsed.scheme or "http").lower()
    port = parsed.port or _DEFAULT_PORT.get(scheme)
    if port is None:
        return f"http_request: could not determine a port for url {url!r}"

    if not scope.allows(host, port):
        return (
            f"BLOCKED: {host}:{port} is out of scope "
            f"(allowlist: {scope.host} ports {list(scope.ports)})"
        )
    return None
