"""ports — container → published host ports (docs/provisioner.md §4 row 4, M4).

`discover(container, timeout_s, backoff)` polls the container to *ready*, then reads
the published HOST ports off `NetworkSettings.Ports` and returns them as `Ports`.

Ready (Phase-A limit, §9 — no app-level readiness):
- If the image declares a HEALTHCHECK, ready = `State.Health.Status == "healthy"`.
- Otherwise ready = `State.Status == "running"`.

Once ready, the published host ports are read once. A `-P` run binds every EXPOSEd
port at start, so an empty map here means the image EXPOSEs nothing → reject
(`NoPortsExposed`, §8 "target exposes nothing to attack"). If the container exits or
never reaches ready before `timeout_s`, capture a `container.logs()` tail for the
manifest and raise `BootTimeout` (§8).
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from docker.errors import APIError
from docker.models.containers import Container

from ..contracts.errors import BootTimeout, NoPortsExposed

# Trailing container-log lines attached to a BootTimeout (§8 "container-log tail").
_LOG_TAIL_LINES = 40

# Poll backoff never sleeps longer than this (seconds) between container.reload()s.
_MAX_BACKOFF = 2.0

# Container states from which readiness can never be reached — reject immediately.
_TERMINAL_STATES = frozenset({"exited", "dead", "removing"})


@dataclass(frozen=True, slots=True)
class Ports:
    """Discovered published host ports (docs/provisioner.md §4 row 4).

    `host` ports are the distinct, sorted host-side ports the target published; the
    scope emitter (M5) pairs them with `127.0.0.1` to write the frozen scope.
    """

    host: tuple[int, ...]


def discover(container: Container, timeout_s: float = 30.0, backoff: float = 0.25) -> Ports:
    """Poll `container` to ready, then return its published host `Ports`.

    Raises `NoPortsExposed` if a ready container published nothing, or `BootTimeout`
    (with a log tail, §8) if it exits or never becomes ready within `timeout_s`.
    """
    deadline = time.monotonic() + timeout_s
    sleep = backoff
    while True:
        container.reload()
        state = container.attrs.get("State", {})
        if state.get("Status") in _TERMINAL_STATES:
            raise _boot_timeout(container, f"container {state.get('Status')} before ready")

        if _is_ready(state):
            host_ports = _host_ports(container.attrs)
            if not host_ports:
                raise NoPortsExposed(
                    "target exposes nothing to attack: container published no ports"
                )
            return Ports(host=host_ports)

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _boot_timeout(container, f"container not ready within {timeout_s}s")
        time.sleep(min(sleep, remaining))
        sleep = min(sleep * 2, _MAX_BACKOFF)


def _is_ready(state: dict) -> bool:
    """True once the container is running (and, if it has a healthcheck, healthy)."""
    if state.get("Status") != "running":
        return False
    health = state.get("Health")
    if health is not None:  # image declared a HEALTHCHECK — honor it
        return health.get("Status") == "healthy"
    return True


def _host_ports(attrs: dict) -> tuple[int, ...]:
    """Distinct, sorted HOST ports from `NetworkSettings.Ports` (each `<cport>/tcp` → bindings)."""
    ports_map = attrs.get("NetworkSettings", {}).get("Ports") or {}
    hosts: set[int] = set()
    for bindings in ports_map.values():
        for binding in bindings or ():
            host_port = binding.get("HostPort")
            if host_port:
                hosts.add(int(host_port))
    return tuple(sorted(hosts))


def _boot_timeout(container: Container, why: str) -> BootTimeout:
    """Wrap a boot failure as `BootTimeout` carrying the container-log tail (§8)."""
    tail = _log_tail(container)
    exc = BootTimeout(f"{why}:\n{tail}" if tail else why)
    exc.log_tail = tail  # programmatic access for the manifest/CLI
    return exc


def _log_tail(container: Container) -> str:
    """Last `_LOG_TAIL_LINES` lines of the container's logs, decoded; "" if unreadable."""
    try:
        raw = container.logs(tail=_LOG_TAIL_LINES)
    except APIError:  # a dead/removed container may refuse logs — tail is best-effort
        return ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return raw.strip()
