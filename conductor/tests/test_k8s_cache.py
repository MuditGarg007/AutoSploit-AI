"""Tests for the long-lived build cache (capacity handoff B2).

Two layers: the pure `content_hash`/`cache_registry` helpers, and a `FakeCache`
driving `phaseb_provision` through the hit / miss / populate / fail-open paths with
no crane and no registry. The security-relevant invariant — a cache hit copies into
the per-engagement registry and launches NO build Pod, while a miss builds and then
populates the cache — is asserted here; the crane-shaped `BuildCache` wrapper's
argv is asserted directly.
"""

from __future__ import annotations

import pytest

from autosploit_conductor.k8s import manifests as m
from autosploit_conductor.k8s.cache import (
    CACHE_IMAGE_REPO,
    CACHE_REGISTRY_ENV,
    BuildCache,
    CacheError,
    cache_registry,
    content_hash,
)
from autosploit_conductor.k8s.provision import phaseb_provision
from tests.test_k8s_provision import (  # reuse the provision fakes
    ID,
    REPO,
    FakeCluster,
    _ctx,
    _fake_clone,
    _mirror_recorder,
)

CACHE_REG = "cache.autosploit-system.svc:5000"


# --- pure helpers ------------------------------------------------------------


def test_cache_registry_reads_env():
    assert cache_registry({CACHE_REGISTRY_ENV: CACHE_REG}) == CACHE_REG
    assert cache_registry({CACHE_REGISTRY_ENV: "  "}) is None  # blank ⇒ off
    assert cache_registry({}) is None  # unset ⇒ off


def test_content_hash_is_stable_and_order_independent():
    a = content_hash({"Dockerfile": "FROM busybox", "app.py": "x"}, "Dockerfile")
    b = content_hash({"app.py": "x", "Dockerfile": "FROM busybox"}, "Dockerfile")
    assert a == b  # dict order must not matter
    assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)


def test_content_hash_changes_with_content_dockerfile_and_boundaries():
    base = content_hash({"Dockerfile": "FROM busybox"}, "Dockerfile")
    assert content_hash({"Dockerfile": "FROM alpine"}, "Dockerfile") != base
    assert content_hash({"Dockerfile": "FROM busybox"}, "Other") != base
    # length-prefixing: {"ab":"c"} and {"a":"bc"} must not collide by concatenation
    assert content_hash({"ab": "c"}, "D") != content_hash({"a": "bc"}, "D")


def test_build_cache_crane_argv(monkeypatch):
    seen: list[list[str]] = []

    def fake_run(argv, **kw):
        seen.append(argv)
        return type("R", (), {"returncode": 0, "stderr": ""})()

    import autosploit_conductor.k8s.cache as cache_mod

    monkeypatch.setattr(cache_mod.subprocess, "run", fake_run)
    cache = BuildCache(CACHE_REG)
    assert cache.ref_for("abc") == f"{CACHE_REG}/{CACHE_IMAGE_REPO}:abc"
    assert cache.image_exists(cache.ref_for("abc")) is True
    cache.copy("a", "b")
    assert seen[0] == ["crane", "manifest", "--insecure", f"{CACHE_REG}/{CACHE_IMAGE_REPO}:abc"]
    assert seen[1] == ["crane", "copy", "--insecure", "a", "b"]


def test_build_cache_copy_failure_raises_cache_error(monkeypatch):
    def fake_run(argv, **kw):
        return type("R", (), {"returncode": 1, "stderr": "boom"})()

    import autosploit_conductor.k8s.cache as cache_mod

    monkeypatch.setattr(cache_mod.subprocess, "run", fake_run)
    cache = BuildCache(CACHE_REG)
    assert cache.image_exists("x") is False  # never raises
    with pytest.raises(CacheError, match="crane copy"):
        cache.copy("a", "b")


def test_ref_for_without_registry_raises():
    with pytest.raises(CacheError, match="not configured"):
        BuildCache(None).ref_for("abc")


# --- provision integration ---------------------------------------------------


class FakeCache:
    """Records cache ops; scripts whether the probed image is a hit."""

    def __init__(self, *, registry: str | None = CACHE_REG, hit: bool = False) -> None:
        self._registry = registry
        self._hit = hit
        self.calls: list = []

    def registry(self):
        return self._registry

    def ref_for(self, digest: str) -> str:
        return f"{self._registry}/{CACHE_IMAGE_REPO}:{digest}"

    def image_exists(self, ref: str) -> bool:
        self.calls.append(("exists", ref))
        return self._hit

    def copy(self, src: str, dst: str) -> None:
        self.calls.append(("copy", src, dst))


def _run(cluster, cache, **kw):
    return phaseb_provision(
        REPO,
        _ctx(),
        cluster,
        target_port=8080,
        now=lambda: 0.0,
        sleep=lambda s: None,
        resolve_fn=_fake_clone(),
        mirror_fn=_mirror_recorder(),
        cache=cache,
        **kw,
    )


def test_cache_hit_copies_into_registry_and_skips_build():
    cluster = FakeCluster({"registry": ["Running"]})  # no build phase scripted
    cache = FakeCache(hit=True)
    prov = _run(cluster, cache)

    # No build context packed, no build Pod launched — the whole build is skipped.
    kinds = [c if isinstance(c, str) else c[0] for c in cluster.calls]
    assert kinds == ["registry_pod", "registry_service"]
    assert not any(k in ("build_context", "build_pod") for k in kinds)

    # The cached image was copied into the per-engagement registry's target ref.
    destination = m.target_image_ref(ID)
    assert ("copy", cache.ref_for(cache.calls[0][1].rsplit(":", 1)[1]), destination) == next(
        c for c in cache.calls if c[0] == "copy"
    )
    assert prov.target_image == destination


def test_cache_miss_builds_then_populates():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    cache = FakeCache(hit=False)
    _run(cluster, cache)

    kinds = [c if isinstance(c, str) else c[0] for c in cluster.calls]
    assert kinds == ["registry_pod", "registry_service", "build_context", "build_pod"]
    # Probed once (miss), then populated from the freshly built image.
    assert cache.calls[0][0] == "exists"
    populate = [c for c in cache.calls if c[0] == "copy"]
    assert populate == [("copy", m.target_image_ref(ID), cache.ref_for(cache.calls[0][1].rsplit(":", 1)[1]))]


def test_cache_off_when_registry_unset_behaves_as_pre_b2():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    cache = FakeCache(registry=None)
    _run(cluster, cache)
    assert cache.calls == []  # never probed/copied
    kinds = [c if isinstance(c, str) else c[0] for c in cluster.calls]
    assert kinds == ["registry_pod", "registry_service", "build_context", "build_pod"]


def test_cache_hit_copy_failure_falls_back_to_build():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})

    class FailingHit(FakeCache):
        def copy(self, src, dst):
            self.calls.append(("copy", src, dst))
            if src.endswith(tuple("0123456789abcdef")) and "/target:latest" not in src:
                raise CacheError("hit copy boom")  # the hit-copy (cache -> registry)

    cache = FailingHit(hit=True)
    _run(cluster, cache)
    # Fell through to a real build despite the hit.
    assert any(isinstance(c, tuple) and c[0] == "build_pod" for c in cluster.calls)


def test_cache_populate_failure_is_swallowed():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})

    class FailingPopulate(FakeCache):
        def copy(self, src, dst):
            self.calls.append(("copy", src, dst))
            raise CacheError("populate boom")

    cache = FailingPopulate(hit=False)
    # A populate failure after a successful build must not raise.
    prov = _run(cluster, cache)
    assert prov.target_image == m.target_image_ref(ID)


def test_dir_context_is_not_cacheable():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    cache = FakeCache(hit=True)  # would hit if probed
    phaseb_provision(
        "dir:///workspace",
        _ctx(),
        cluster,
        target_port=8080,
        now=lambda: 0.0,
        sleep=lambda s: None,
        resolve_fn=_fake_clone(),
        mirror_fn=_mirror_recorder(),
        cache=cache,
    )
    assert cache.calls == []  # no files to hash ⇒ cache never consulted
