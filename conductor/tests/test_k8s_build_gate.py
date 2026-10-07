"""Tests for the cross-process build gate (capacity lever A2).

`BuildGate` is driven against a tiny in-memory ZSET fake (no Redis, no network, no
waiting via injected clock/sleep), so the semaphore logic — admit up to `limit`,
block the overflow, reclaim an expired lease, release on exit — is proven directly.
The env-driven `build_slot` factory is checked for its fail-open/ungated defaults.
"""

from __future__ import annotations

from autosploit_conductor.k8s.build_gate import _GATE_KEY, BuildGate, build_slot


class FakeZSet:
    """Minimal sorted-set fake covering the four client calls the gate makes."""

    def __init__(self) -> None:
        self.data: dict[str, float] = {}
        self.fail = False

    def _maybe_fail(self) -> None:
        if self.fail:
            raise RuntimeError("redis down")

    def zremrangebyscore(self, name: str, min, max) -> int:
        self._maybe_fail()
        assert name == _GATE_KEY
        hi = float("inf") if max == "+inf" else float(max)
        gone = [m for m, s in self.data.items() if s <= hi]
        for m in gone:
            del self.data[m]
        return len(gone)

    def zadd(self, name: str, mapping: dict[str, float]) -> int:
        self._maybe_fail()
        self.data.update(mapping)
        return len(mapping)

    def zrank(self, name: str, value: str):
        self._maybe_fail()
        if value not in self.data:
            return None
        order = sorted(self.data, key=lambda m: (self.data[m], m))
        return order.index(value)

    def zrem(self, name: str, *values: str) -> int:
        self._maybe_fail()
        n = 0
        for v in values:
            if v in self.data:
                del self.data[v]
                n += 1
        return n


def _gate(client, *, limit=2, lease_s=1000.0, wait_s=100.0, poll_s=1.0, clock=None):
    t = clock or [0.0]

    def now() -> float:
        return t[0]

    def sleep(s: float) -> None:
        t[0] += s

    return BuildGate(
        client, limit=limit, lease_s=lease_s, wait_s=wait_s, poll_s=poll_s,
        now=now, sleep=sleep,
    ), t


def test_admits_up_to_limit_and_releases_on_exit():
    z = FakeZSet()
    gate, _ = _gate(z, limit=2)
    with gate.slot():
        assert len(z.data) == 1
        with gate.slot():
            assert len(z.data) == 2  # both slots held concurrently
        assert len(z.data) == 1  # inner released
    assert z.data == {}  # all released


def test_overflow_waits_then_ungated_on_wait_timeout():
    # limit 1, one slot pre-held by someone else (acquired strictly earlier, score
    # 0 vs our clock start 10) and never released → our acquire can never win and
    # degrades to ungated after wait_s rather than deadlocking.
    z = FakeZSet()
    z.data["other"] = 0.0
    gate, clock = _gate(z, limit=1, lease_s=1000.0, wait_s=5.0, poll_s=1.0, clock=[10.0])
    with gate.slot():
        # We hold no token (ungated); only the pre-existing holder remains.
        assert set(z.data) == {"other"}
    assert set(z.data) == {"other"}
    assert clock[0] >= 15.0  # waited out the full budget before giving up


def test_expired_lease_is_reclaimed():
    # A dead holder's token is older than the lease → purged on the next acquire,
    # freeing its slot.
    z = FakeZSet()
    z.data["dead"] = 0.0
    gate, _ = _gate(z, limit=1, lease_s=100.0, clock=[500.0])
    with gate.slot():
        assert "dead" not in z.data  # reclaimed
        assert len(z.data) == 1  # our live token holds the only slot
    assert z.data == {}


def test_redis_failure_is_fail_open():
    z = FakeZSet()
    z.fail = True
    gate, _ = _gate(z, limit=1)
    with gate.slot():  # must not raise; proceeds ungated
        pass
    # release of a None token is a no-op; nothing was recorded.
    assert z.data == {}


def test_build_slot_noop_when_unconfigured(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("BUILD_CONCURRENCY", raising=False)
    with build_slot():  # no Redis touched, no error
        pass


def test_build_slot_noop_when_concurrency_zero(monkeypatch):
    # REDIS_URL set but concurrency 0 → disabled, returns the no-op CM. A broken
    # redis module proves the factory never reaches the connect path.
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    monkeypatch.setenv("BUILD_CONCURRENCY", "0")
    import sys
    import types

    broken = types.ModuleType("redis")
    broken.Redis = types.SimpleNamespace(  # type: ignore[attr-defined]
        from_url=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not connect"))
    )
    monkeypatch.setitem(sys.modules, "redis", broken)
    with build_slot():
        pass


def test_build_slot_fail_open_when_redis_import_or_connect_fails(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    monkeypatch.setenv("BUILD_CONCURRENCY", "2")
    import sys
    import types

    broken = types.ModuleType("redis")

    def _from_url(*a, **k):
        raise RuntimeError("cannot connect")

    broken.Redis = types.SimpleNamespace(from_url=_from_url)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "redis", broken)
    with build_slot():  # degrades to the no-op CM, no raise
        pass
