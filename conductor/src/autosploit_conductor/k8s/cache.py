"""Long-lived build cache — content-hash full-skip (capacity handoff B2).

The one CPU-heavy stretch of an engagement on the single 4-vCPU box is the build
(Kaniko layer snapshotting + push-side gzip, plus the conductor-side base mirror).
A re-run of an *unchanged* target repeats all of it for an identical result. B2
removes that cost: the conductor content-hashes the packed build context and, if a
long-lived cache registry already holds the image for that hash, `crane copy`s it
straight into the per-engagement registry and skips the mirror + Kaniko build
entirely (100 % of the build CPU gone for that run). A miss builds as before and
then populates the cache for next time.

Why this shape, and not Kaniko's own `--cache=true --cache-repo`:

- The per-engagement registry dies with the namespace, so the cache must live in a
  **separate, long-lived** registry. That registry is written only by the
  **conductor** (the trusted control-plane side), never by the untrusted Kaniko
  Pod — so no cross-engagement cache-poisoning surface opens, and the build Pod
  gets no new egress edge. The crane copy that populates the cache runs in the
  control-plane Pod, exactly like the M5 base mirror (`mirror.py`), so there is no
  docker socket anywhere in this path either.
- Addressing cached images by a content hash means a hit is byte-identical to what
  a rebuild would produce; a changed context lands on a different tag and misses.

**Fail-open, opt-in.** The cache is enabled only when `BUILD_CACHE_REGISTRY` names
a reachable registry. Unset ⇒ caching is off and provision behaves exactly as it
did before B2. A cache probe/copy failure (unreachable registry, crane error) never
fails an engagement: a hit-copy failure falls back to a real build, and a populate
failure after a successful build is swallowed — the target image is already built
and pushed to the per-engagement registry regardless.

Caveat (MVP): the hash covers the packed context (every file, including the
Dockerfile). A `FROM <base>:latest` whose upstream digest drifts is *not* reflected
in the hash, so a cache hit could serve a target built against a now-stale base
until the context itself changes. Pin base tags (or digests) in the target repo to
avoid this; a digest-resolving hash is the follow-up if it ever bites.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from collections.abc import Mapping

# Env naming the long-lived cache registry as `host:port` (e.g. an in-cluster
# Service in a stable namespace, inside the trust boundary). Unset/empty ⇒ off.
CACHE_REGISTRY_ENV = "BUILD_CACHE_REGISTRY"

# Repository path for cached target images within the cache registry. The tag is
# the content hash, so the full ref is `<registry>/<CACHE_IMAGE_REPO>:<hash>`.
CACHE_IMAGE_REPO = "target-cache"


class CacheError(RuntimeError):
    """A crane operation against the cache registry failed.

    Carried so callers can fall back fail-open (build on a hit-copy failure, swallow
    a populate failure) rather than crash the engagement.
    """


def cache_registry(env: Mapping[str, str] = os.environ) -> str | None:
    """The configured cache registry `host:port`, or None when caching is off."""
    value = env.get(CACHE_REGISTRY_ENV, "").strip()
    return value or None


def content_hash(files: Mapping[str, str], dockerfile: str) -> str:
    """A stable sha256 over the packed build context + the Dockerfile path.

    Length-prefixes each path and its content so no two distinct contexts collide by
    concatenation (`{"ab": "c"}` and `{"a": "bc"}` hash differently). The Dockerfile
    path is folded in because the same files built against a different Dockerfile
    within the context is a different build. Deterministic given identical inputs,
    which is the whole point: an unchanged context yields the same tag and hits.
    """
    digest = hashlib.sha256()
    digest.update(dockerfile.encode("utf-8"))
    digest.update(b"\0")
    for path in sorted(files):
        data = files[path].encode("utf-8")
        digest.update(path.encode("utf-8"))
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


class BuildCache:
    """crane-backed cache operations against the long-lived cache registry.

    Injected into `phaseb_provision` (default: this class reading the env) so the
    whole provision flow unit-tests against a fake with no crane and no registry —
    the same seam the clone (`resolve_source`) and base mirror (`mirror_base_image`)
    use. All crane calls run in the control-plane Pod; the cache registry is plain
    HTTP inside the cluster, so `--insecure` is passed (as the mirror/push do).
    """

    def __init__(self, registry: str | None = None, *, insecure: bool = True) -> None:
        # None means "read the env now" (lazy, so a runtime-set env is honoured);
        # pass an explicit value in tests/alternate deploys.
        self._registry = registry if registry is not None else cache_registry()
        self._insecure = insecure

    def registry(self) -> str | None:
        """The cache registry, or None when caching is off (unset env)."""
        return self._registry

    def ref_for(self, digest: str) -> str:
        """The cache image ref for a content hash: `<registry>/target-cache:<hash>`."""
        if self._registry is None:
            raise CacheError("cache registry is not configured")
        return f"{self._registry}/{CACHE_IMAGE_REPO}:{digest}"

    def image_exists(self, ref: str) -> bool:
        """True if `ref` resolves in the cache registry (a `crane manifest` succeeds).

        Never raises: an unreachable registry or a crane error reads as "no cache
        hit", so provision falls through to a real build (fail-open).
        """
        result = subprocess.run(
            self._crane("manifest", ref), capture_output=True, text=True, check=False
        )
        return result.returncode == 0

    def copy(self, src: str, dst: str) -> None:
        """`crane copy src dst` — move an image between registries (no rebuild).

        Used both to pull a cache hit into the per-engagement registry and to
        populate the cache from a freshly built image. Raises `CacheError` on
        failure so the caller can fall back (hit) or swallow it (populate).
        """
        result = subprocess.run(
            self._crane("copy", src, dst), capture_output=True, text=True, check=False
        )
        if result.returncode != 0:
            raise CacheError(f"crane copy {src} -> {dst} failed: {result.stderr.strip()}")

    def _crane(self, *args: str) -> list[str]:
        cmd = ["crane", args[0]]
        if self._insecure:
            cmd.append("--insecure")
        cmd.extend(args[1:])
        return cmd
