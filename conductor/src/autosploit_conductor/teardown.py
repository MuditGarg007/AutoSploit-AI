"""Teardown — wrapper over the provisioner's teardown + out-dir removal (docs/conductor.md §7 [6]).

The conductor is the trusted half: the container half is delegated to the
provisioner's own `teardown(engagement_id)` (idempotent rm-by-label on
`label=engagement=<id>`), and the workdir half is covered by removing the whole
engagement out-dir we own (`docs/conductor.md §3.1`). `register` wires both onto
atexit + SIGINT/SIGTERM, reusing the provisioner's guard pattern, so a crashed or
interrupted conductor leaves no target container and no out-dir (§8).

Both halves are idempotent: a second call is a no-op, not an error (§4 [6], C4).
The container half is injected through a seam (defaulting to the provisioner's
real `teardown`) so the C4 gate can be proven deterministically without a Docker
daemon — the real container half is exercised in the C6 integration run.
"""

from __future__ import annotations

import atexit
import shutil
import signal
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from autosploit_provisioner.teardown import teardown as _provisioner_teardown

from autosploit_conductor.context import EngagementContext

# Engagements already wired to atexit/signals, so register() is idempotent too.
_REGISTERED: set[str] = set()

# Retry budget for removing the out-dir: a transient lock (e.g. a git pack file
# still held by a child at teardown time, common on Windows) can make the first
# rmtree fail; we retry a few times with a short backoff before giving up, so a
# lock that clears quickly doesn't leak residue (§8, C6 "zero residue").
_RMTREE_ATTEMPTS = 5
_RMTREE_BACKOFF_S = 0.4

# The container half. A callable `(engagement_id, out_dir) -> None` that removes
# every `engagement=<id>` container — defaults to the provisioner's own teardown
# (which also deletes a workdir; we pass our out_dir so a stale container's
# workdir is cleaned too, then we remove the out-dir ourselves below).
teardown_container: Callable[[str, Path | None], None] = _provisioner_teardown


def teardown_run(
    ctx: EngagementContext,
    *,
    container_teardown: Callable[[str, Path | None], None] | None = None,
) -> None:
    """Tear the run down: containers first, then the engagement out-dir. Idempotent.

    The out-dir is always removed. If the container half fails (e.g. the Docker
    daemon is unreachable) the error is surfaced on stderr and swallowed, so a
    teardown in a `finally` can never mask the run's primary result — but a
    teardown failure is still loud enough to be caught (§8).
    """
    try:
        (container_teardown or teardown_container)(ctx.engagement_id, ctx.out_dir)
    except Exception as exc:  # noqa: BLE001 — teardown must not mask the primary result
        print(f"conductor: container teardown failed: {exc}", file=sys.stderr, flush=True)
    finally:
        _rmtree_retry(ctx.out_dir)


def _rmtree_retry(path: Path) -> None:
    """Remove `path`, retrying on transient failures (e.g. Windows file locks).

    A short bounded retry clears locks that release quickly (a child still
    holding a cloned git pack file at teardown time); whatever is still locked
    after the budget is left for the caller to notice — teardown never raises,
    so it can't mask the run's primary result (§8).
    """
    for attempt in range(_RMTREE_ATTEMPTS):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return
        if attempt < _RMTREE_ATTEMPTS - 1:
            time.sleep(_RMTREE_BACKOFF_S)


def register(
    ctx: EngagementContext,
    *,
    container_teardown: Callable[[str, Path | None], None] | None = None,
) -> None:
    """Ensure `teardown_run(ctx)` runs on normal exit and on SIGINT/SIGTERM.

    Idempotent per engagement. Signal handlers are only installed when called
    from the main thread; if not, atexit still covers normal and unhandled-exception
    exits (the provisioner's `register` uses the same pattern, §4 [6]).
    """
    if ctx.engagement_id in _REGISTERED:
        return
    _REGISTERED.add(ctx.engagement_id)

    def _run() -> None:
        teardown_run(ctx, container_teardown=container_teardown)

    atexit.register(_run)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            prev = signal.getsignal(sig)
            signal.signal(sig, _make_handler(_run, sig, prev))
        except (ValueError, OSError):
            # Not the main thread, or the signal is unsupported on this platform —
            # atexit still guarantees cleanup on a normal exit.
            pass


def _make_handler(run: Callable[[], Any], sig: int, prev: Any) -> Callable[[int, Any], None]:
    """A signal handler that tears down once, then chains to the previous disposition."""

    def _handler(signum: int, frame: Any) -> None:
        run()
        if callable(prev):
            prev(signum, frame)
        else:
            # Restore the default action and re-raise it so exit codes stay correct.
            signal.signal(sig, signal.SIG_DFL)
            if sig == signal.SIGINT:
                raise KeyboardInterrupt
            raise SystemExit(128 + int(sig))

    return _handler
