"""teardown — remove containers + workdir, idempotent (docs/provisioner.md §4 row 7).

`docker rm -f` everything matching `label=engagement=<id>`, then remove the
workdir. Idempotent (a second call is a no-op, not an error) and registered on
atexit + SIGINT/SIGTERM, so a crashed provision leaves no orphaned container or
workdir. Always runs — success, failure, or interrupt (§8).
"""

from __future__ import annotations

from .teardown import register, teardown

__all__ = ["register", "teardown"]
