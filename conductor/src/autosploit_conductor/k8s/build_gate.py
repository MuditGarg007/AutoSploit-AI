"""Cross-process build-phase gate (capacity lever A2, docs/capacity-cpu-handoff.md).

Once the control plane runs several engagements at once (lever A1 raised the BullMQ
worker concurrency above 1), their long attack phases overlap for free — they only
wait on the model API. The *build* phase is the one CPU-heavy stretch (Kaniko layer
snapshotting + gzip on push, plus the conductor-side `crane copy`), and on the
single 4-vCPU box ~2-3 concurrent builds saturate the cores. This gate caps how
many engagements run their build phase simultaneously, while leaving the idle attack
phases ungated, so A1's throughput win does not turn into a build thundering herd.

The build runs inside the conductor subprocess (`provision.phaseb_provision`), so
the cap has to be a cross-*process* primitive shared by every concurrent conductor,
not an in-process lock. It is a counted semaphore in Redis — the same Redis the
control plane already runs for BullMQ — implemented as a sorted set of slot tokens
scored by acquire time. Each holder's token self-expires after a lease, so a
conductor that crashes mid-build never permanently burns a slot.

**Fail-open** (matches the quota meter, EnvService.quotaFailOpen): if the gate is
not configured (no `REDIS_URL`/`BUILD_CONCURRENCY`) or Redis is unreachable, the
build runs *ungated* — exactly today's behaviour — rather than blocking an
engagement on a meter outage. Under extreme contention an acquire that cannot win a
slot within `BUILD_GATE_WAIT_S` also proceeds ungated rather than deadlocking; the
engagement's own `--timeout-s` is the real backstop.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Redis sorted-set key holding the live build-slot tokens (score = acquire epoch).
_GATE_KEY = "autosploit:build-gate"

# Lease must comfortably outlast one build (provision build_timeout_s defaults to
# 900 s) so a slow-but-live build is never reclaimed out from under itself. The slot
# count itself has no default — the gate is off unless BUILD_CONCURRENCY is set
# (handoff §3: ~2-3 concurrent builds before CPU saturation on the single box).
_DEFAULT_LEASE_S = 1200.0
_DEFAULT_WAIT_S = 1800.0
_DEFAULT_POLL_S = 0.5


class _ZSetClient(Protocol):
    """The slice of a Redis client the gate drives (sync `redis.Redis`)."""

    def zremrangebyscore(self, name: str, min: Any, max: Any) -> int: ...
    def zadd(self, name: str, mapping: dict[str, float]) -> int: ...
    def zrank(self, name: str, value: str) -> int | None: ...
    def zrem(self, name: str, *values: str) -> int: ...


class BuildGate:
    """A counted semaphore over `_GATE_KEY`; `limit` holders may build at once.

    Purely a wrapper around an injected Redis-shaped client plus a clock, so it is
    unit-tested against a fake ZSET with no network and no waiting. The env-driven
    `build_slot` factory builds the production instance.
    """

    def __init__(
        self,
        client: _ZSetClient,
        *,
        limit: int,
        lease_s: float,
        wait_s: float,
        poll_s: float,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._client = client
        self._limit = limit
        self._lease_s = lease_s
        self._wait_s = wait_s
        self._poll_s = poll_s
        self._now = now
        self._sleep = sleep

    @contextmanager
    def slot(self) -> Iterator[None]:
        """Hold one build slot for the duration of the block.

        Acquires before yielding and always releases after. Any Redis error, or a
        wait that exceeds `wait_s`, degrades to ungated (fail-open) so a meter
        outage never blocks an engagement.
        """
        token = self._acquire()
        try:
            yield
        finally:
            self._release(token)

    def _acquire(self) -> str | None:
        """Return the held slot token, or None when proceeding ungated (fail-open)."""
        token = uuid.uuid4().hex
        deadline = self._now() + self._wait_s
        while True:
            try:
                now = self._now()
                # Reclaim slots whose lease expired (crashed/hung holders).
                self._client.zremrangebyscore(_GATE_KEY, "-inf", now - self._lease_s)
                self._client.zadd(_GATE_KEY, {token: now})
                rank = self._client.zrank(_GATE_KEY, token)
                if rank is not None and rank < self._limit:
                    return token
                # Over capacity: drop our bid and wait for a slot to free.
                self._client.zrem(_GATE_KEY, token)
            except Exception as exc:  # noqa: BLE001 — Redis down/flaky → fail-open, build ungated.
                logger.warning("build gate unavailable, building ungated: %s", exc)
                return None
            if self._now() >= deadline:
                logger.warning(
                    "build gate wait exceeded %.0fs, building ungated", self._wait_s
                )
                return None
            self._sleep(self._poll_s)

    def _release(self, token: str | None) -> None:
        if token is None:
            return
        try:
            self._client.zrem(_GATE_KEY, token)
        except Exception as exc:  # noqa: BLE001 — best-effort; the lease reclaims it anyway.
            logger.warning("build gate release failed (lease will reclaim): %s", exc)


@contextmanager
def _noop_slot() -> Iterator[None]:
    yield


def build_slot() -> Any:
    """Production build-gate context manager, configured from the environment.

    Returns a no-op (ungated) context manager unless both `REDIS_URL` and a positive
    `BUILD_CONCURRENCY` are set — so Phase-A-only, local, and test runs need no Redis
    and nothing changes for them. A Redis import/connect failure also degrades to the
    no-op, consistent with the fail-open contract above.
    """
    redis_url = os.environ.get("REDIS_URL")
    limit = _int_env("BUILD_CONCURRENCY", 0)
    if not redis_url or limit <= 0:
        return _noop_slot()
    try:
        import redis  # imported lazily: unused on the ungated path.

        client = redis.Redis.from_url(redis_url, decode_responses=True)
    except Exception as exc:  # noqa: BLE001 — missing dep / bad URL → ungated.
        logger.warning("build gate disabled (redis unavailable): %s", exc)
        return _noop_slot()
    gate = BuildGate(
        client,
        limit=limit,
        lease_s=_float_env("BUILD_GATE_LEASE_S", _DEFAULT_LEASE_S),
        wait_s=_float_env("BUILD_GATE_WAIT_S", _DEFAULT_WAIT_S),
        poll_s=_float_env("BUILD_GATE_POLL_S", _DEFAULT_POLL_S),
    )
    return gate.slot()


def _int_env(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("invalid %s=%r, using %d", key, raw, default)
        return default


def _float_env(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("invalid %s=%r, using %s", key, raw, default)
        return default
