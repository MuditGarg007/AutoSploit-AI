"""teardown — rm-by-label + workdir, idempotent (docs/provisioner.md §4 row 7, §8, M5).

`teardown(engagement_id, workdir)` removes every container carrying
`label=engagement=<id>` (force, so a running target dies too), then removes the
workdir. It is idempotent: a second call finds no containers and treats a missing
workdir as already-done, so it is safe to run on success, on failure, and again on
process exit without erroring.

`register(engagement_id, workdir)` wires that same teardown onto `atexit` plus the
SIGINT/SIGTERM handlers, so a crashed or interrupted provision still leaves no
orphaned container or workdir (§8). Registration is guarded — signal handlers can
only be installed from the main thread — and de-duplicated per engagement.
"""

from __future__ import annotations

import atexit
import shutil
import signal
from pathlib import Path

from docker.errors import NotFound

from ..build.booter import ENGAGEMENT_LABEL
from ..docker_env import docker_client

# Engagements already wired to atexit/signals, so register() is idempotent too.
_REGISTERED: set[str] = set()


def teardown(engagement_id: str, workdir: Path | None = None) -> None:
    """Force-remove all `engagement=<id>` containers and the workdir. Idempotent.

    Never raises for already-gone artifacts: a missing container or workdir is the
    success state, not an error (so repeat calls are no-ops, §8).
    """
    client = docker_client()
    containers = client.containers.list(
        all=True, filters={"label": f"{ENGAGEMENT_LABEL}={engagement_id}"}
    )
    for container in containers:
        try:
            container.remove(force=True)
        except NotFound:
            pass  # already gone — idempotent

    if workdir is not None:
        # ignore_errors swallows a missing dir, making the second call a no-op.
        shutil.rmtree(workdir, ignore_errors=True)


def register(engagement_id: str, workdir: Path | None = None) -> None:
    """Ensure `teardown(engagement_id, workdir)` runs on normal exit and on SIGINT/SIGTERM.

    Idempotent per engagement. Signal handlers are only installed when called from
    the main thread; if not, atexit still covers normal and unhandled-exception exits.
    """
    if engagement_id in _REGISTERED:
        return
    _REGISTERED.add(engagement_id)

    def _run() -> None:
        teardown(engagement_id, workdir)

    atexit.register(_run)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            prev = signal.getsignal(sig)
            signal.signal(sig, _make_handler(_run, sig, prev))
        except (ValueError, OSError):
            # Not the main thread, or the signal is unsupported on this platform —
            # atexit still guarantees cleanup on a normal exit.
            pass


def _make_handler(run, sig, prev):
    """A signal handler that tears down once, then chains to the previous disposition."""

    def _handler(signum, frame):
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
