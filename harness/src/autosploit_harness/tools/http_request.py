"""http_request — structured HTTP adapter (docs/harness.md §4, §3).

    http_request(method, url, headers?, body?) -> HttpResult

The url is THE interceptable field: structured, so the interceptor parses host +
port and checks scope with no shell parsing (§3). Dashboard shows "GET
/api/users", not an opaque blob. Returns status + headers + body in full; the
tool node caps the transcript preview and spills the full body to the ledger.

Pure adapter: by the time it runs, the interceptor has already scope-checked the
url (§3). A network failure (DNS/connect/timeout) comes back as an HttpResult
with `error` set, never a raised exception — the agent reads it and adapts.
"""

from __future__ import annotations

import httpx

from autosploit_harness.contracts.results import HttpResult

DEFAULT_TIMEOUT = 30


def http_request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> HttpResult:
    """Issue one HTTP request, return a structured HttpResult (full body).

    Redirects are NOT followed — a redirect can hop off the scoped target, and
    scope was checked on the url given, not on wherever it points (§3). The agent
    sees the 3xx + Location and can issue the next (re-scoped) request itself.
    """
    method = (method or "GET").upper()
    try:
        response = httpx.request(
            method,
            url,
            headers=headers or None,
            content=body,
            timeout=timeout,
            follow_redirects=False,
        )
    except httpx.HTTPError as e:
        return HttpResult(method=method, url=url, status=0, error=repr(e))

    return HttpResult(
        method=method,
        url=url,
        status=response.status_code,
        headers=dict(response.headers),
        body=response.text,  # full; the tool node caps the transcript preview (§9 step 3)
    )
