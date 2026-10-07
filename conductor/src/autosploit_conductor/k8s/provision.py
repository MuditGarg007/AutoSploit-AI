"""Phase B provision — the in-cluster target build (roadmap M8).

`run_k8s` hands this seam the `EngagementCluster` and expects a `K8sProvision`
back (or an exception, which it records as a clean `failed(provision)` — the target
never came up — rather than a crash, mirroring Phase A §8).

The real work, all inside the engagement namespace so nothing touches the node and
the whole path works air-gapped (M8 registry decision, 2026-09-26):

1. stand up the per-engagement in-cluster registry (Pod + Service) and wait for it
   to be `Running` — Kaniko pushes to it, the target Pod later pulls from it;
2. under the live M7 default-deny egress the build Pod can reach no external git
   host or base registry, so the conductor (which *does* have egress) preps the
   build in-cluster first (M5): clone the repo conductor-side, preload each external
   `FROM` base into the per-engagement registry (`mirror.py`), and pack the workdir
   into a `dir://` build-context ConfigMap. Then run the **Kaniko** build Pod
   (build the Dockerfile in userspace → push to the registry) with a `dir://`
   context + `--registry-mirror` and **no docker socket anywhere** — the point of
   the milestone — and watch it to `Succeeded`;
3. emit the ConfigMap payload (scope.yaml pointing at the target Service DNS +
   run.toml), which shares the M6a scope contract, and return the built image ref.

The target port is supplied by the operator (`--target-port`), bound in by the CLI
via `functools.partial`, because a Dockerfile repo does not reliably declare it.
"""

from __future__ import annotations

import tempfile
import time
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path

from autosploit_provisioner.contracts.plan import Source
from autosploit_provisioner.source.cloner import resolve_source

from autosploit_conductor import config_gen
from autosploit_conductor.context import EngagementContext
from autosploit_conductor.k8s import manifests as m
from autosploit_conductor.k8s.build_gate import build_slot
from autosploit_conductor.k8s.cache import BuildCache, CacheError, content_hash
from autosploit_conductor.k8s.client import EngagementCluster
from autosploit_conductor.k8s.mirror import mirror_base_image
from autosploit_conductor.k8s.run import K8sProvision
from autosploit_conductor.k8s.watch import wait_pod_running, watch_pod

# A ConfigMap has a hard 1 MiB limit on its data; the packed build context must fit
# under it. This is the accepted MVP repo-size ceiling (fail-closed on oversize); a
# larger context rides the deferred git-mirror Pod (deferred-open-items.md).
_CONFIGMAP_MAX_BYTES = 1024 * 1024

# Where the harness writes its report inside the attacker Pod. Pod-local: the report
# is collected from the Pod (logs), not a shared disk (run.py `_collect_logs`).
_POD_OUTPUT_DIR = "/tmp/autosploit-out"
_SCOPE_BASENAME = "scope.yaml"


class ProvisionError(RuntimeError):
    """The target never came up — recorded as failed(provision), not a crash."""


def phaseb_provision(
    repo_ref: str,
    ctx: EngagementContext,
    cluster: EngagementCluster,
    *,
    target_port: int,
    service_port: int | None = None,
    dockerfile: str = m.DEFAULT_DOCKERFILE,
    registry_timeout_s: float = 120.0,
    build_timeout_s: float = 900.0,
    poll_interval_s: float = 2.0,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    resolve_fn: Callable[[str, Path], Source] = resolve_source,
    mirror_fn: Callable[[str, str], None] = mirror_base_image,
    gate_fn: Callable[[], AbstractContextManager[None]] = build_slot,
    cache: BuildCache | None = None,
) -> K8sProvision:
    """Build the target in-cluster with Kaniko and return its deploy handle (M8)."""
    engagement_id = ctx.engagement_id
    destination = m.target_image_ref(engagement_id)
    # Long-lived build cache (handoff B2). `None` ⇒ read `BUILD_CACHE_REGISTRY` now;
    # unset there ⇒ caching off and the flow is exactly the pre-B2 build path.
    cache = cache if cache is not None else BuildCache()

    # 1. Registry up and ready before anything pushes to it.
    cluster.create_registry_pod()
    cluster.create_registry_service()
    if not wait_pod_running(
        cluster,
        m.REGISTRY_POD_NAME,
        timeout_s=registry_timeout_s,
        poll_interval_s=poll_interval_s,
        now=now,
        sleep=sleep,
    ):
        raise ProvisionError("in-cluster registry did not become ready")

    # 2. Prep the build in-cluster (M5): clone conductor-side, preload the external
    #    bases into the mirror, pack the workdir into a ConfigMap. Then Kaniko builds
    #    from the `dir://` context and pulls bases via `--registry-mirror` — no egress
    #    from the build Pod, which the live M7 policy denies anyway.
    #
    #    This whole stretch — the conductor-side clone/`crane copy` and the Kaniko
    #    build Pod — is the one CPU-heavy phase, so it runs inside the build gate
    #    (capacity lever A2). The gate caps concurrent builds across every running
    #    conductor; the registry (above) and scope emit (below) stay ungated, and
    #    the long attack phase that follows in `run_k8s` never holds a slot.
    with gate_fn():
        prepared = _clone_and_pack(
            repo_ref,
            engagement_id,
            dockerfile=dockerfile,
            resolve_fn=resolve_fn,
        )

        # Build-cache fast path (B2): an unchanged context whose image is already in
        # the long-lived cache is copied straight into the per-engagement registry,
        # skipping the base mirror + Kaniko build entirely. Only a real build context
        # (not the `dir://` passthrough) is cacheable, and only when a cache registry
        # is configured. Fail-open: a probe/copy failure falls back to a real build.
        cache_ref: str | None = None
        built_from_cache = False
        if prepared.files is not None and cache.registry() is not None:
            cache_ref = cache.ref_for(content_hash(prepared.files, dockerfile))
            try:
                if cache.image_exists(cache_ref):
                    cache.copy(cache_ref, destination)
                    built_from_cache = True
            except CacheError:
                built_from_cache = False  # fall through to a real build

        if not built_from_cache:
            # Mirror each external `FROM` base into the per-engagement registry, pack
            # the context ConfigMap, then run Kaniko and watch to a terminal phase
            # (only Succeeded is a build). A `dir://` passthrough has no files to pack
            # or bases to mirror — its context is staged on the builders already.
            context_configmap: str | None = None
            if prepared.files is not None:
                try:
                    for base in prepared.bases:
                        mirror_fn(base, _mirror_dst(base, prepared.mirror))
                except Exception as exc:  # crane / mirror failures → fail-closed
                    raise ProvisionError(
                        f"build-context preparation failed: {exc}"
                    ) from exc
                context_configmap = cluster.create_build_context_configmap(prepared.files)
            cluster.create_build_pod(
                context=prepared.context,
                destination=destination,
                dockerfile=dockerfile,
                context_configmap=context_configmap,
                registry_mirror=prepared.mirror,
            )
            outcome = watch_pod(
                cluster,
                m.BUILD_POD_NAME,
                timeout_s=build_timeout_s,
                poll_interval_s=poll_interval_s,
                now=now,
                sleep=sleep,
            )
            if outcome.timed_out:
                raise ProvisionError("kaniko build timed out")
            if outcome.phase != "Succeeded":
                raise ProvisionError(
                    f"kaniko build failed (phase={outcome.phase}, exit={outcome.exit_code})"
                )
            # Populate the cache from the freshly built image. Fail-open: the target
            # is already built and pushed, so a cache-populate failure is swallowed.
            if cache_ref is not None:
                try:
                    cache.copy(destination, cache_ref)
                except CacheError:
                    pass

    # 3. Scope + run config for the attacker, pointing at the target's Service DNS.
    dialed_port = service_port if service_port is not None else target_port
    config_files = _emit_config(ctx, host=m.target_service_dns(engagement_id), port=dialed_port)

    return K8sProvision(
        config_files=config_files,
        target_image=destination,
        target_port=target_port,
        service_port=service_port,
    )


@dataclass(frozen=True)
class _Prepared:
    """The conductor-side build inputs, before anything touches the build Pod.

    `files` is the packed repo workdir (relative path -> text) and `bases` the
    external `FROM` images to mirror; both are `None`/empty for a `dir://`
    passthrough, whose context is staged on the builders rather than cloned here.
    `context` is the Kaniko `--context` URI and `mirror` the `--registry-mirror`
    endpoint (None on passthrough). Splitting clone+pack out from the mirror/build
    step lets the caller content-hash `files` for the cache fast path (B2) before
    deciding whether to mirror and build at all.
    """

    context: str
    files: Mapping[str, str] | None
    bases: list[str]
    mirror: str | None


def _clone_and_pack(
    repo_ref: str,
    engagement_id: str,
    *,
    dockerfile: str,
    resolve_fn: Callable[[str, Path], Source],
) -> _Prepared:
    """Clone conductor-side and pack the context under the live egress (M5).

    A ref that already names an in-cluster `dir://` context is passed straight
    through — nothing to clone (the negative-control `git://` context the proof uses
    is created directly on the builders, never here). Every other ref is cloned via
    the reused provisioner `resolve_source`, its external `FROM` bases discovered,
    and its workdir packed into the build-context map (fail-closed on oversize). The
    base *mirror* and the ConfigMap creation happen later in `phaseb_provision`, only
    on a cache miss. A clone/read/oversize failure raises `ProvisionError` (recorded
    as `failed(provision)`, never a crash).
    """
    if repo_ref.startswith("dir://"):
        return _Prepared(context=repo_ref, files=None, bases=[], mirror=None)

    mirror = m.registry_mirror_endpoint(engagement_id)
    with tempfile.TemporaryDirectory(prefix=f"autosploit-{engagement_id}-") as tmp:
        workdir = Path(tmp)
        try:
            source = resolve_fn(_clone_ref(repo_ref), workdir)
            repo_root = source.path
            if repo_root is None:
                raise ProvisionError(
                    f"repo ref {repo_ref!r} resolved to a prebuilt image, not a "
                    "buildable repo; Phase B builds a Dockerfile repo in-cluster "
                    "(compose/image sources deferred, roadmap §5)"
                )
            bases = _external_bases(repo_root / dockerfile)
            files = _pack_context(repo_root)
        except ProvisionError:
            raise
        except Exception as exc:  # clone / read failures → fail-closed
            raise ProvisionError(f"build-context preparation failed: {exc}") from exc

    return _Prepared(
        context=f"dir://{m.BUILD_CONTEXT_MOUNT}",
        files=files,
        bases=bases,
        mirror=mirror,
    )


def _clone_ref(repo_ref: str) -> str:
    """Shape `repo_ref` into something `resolve_source` clones (not misreads).

    The conductor's convention is a bare `host/org/repo`; `resolve_source` would read
    that as a prebuilt image ref (its precedence fallback), so a bare ref is given an
    `https://` remote to clone conductor-side. A ref that already carries a scheme, is
    an scp-like git remote (`git@host:org/repo`), or names an existing local path is
    passed through untouched."""
    if "://" in repo_ref or Path(repo_ref).exists():
        return repo_ref
    if "@" in repo_ref and ":" in repo_ref.split("@", 1)[1]:  # scp-like git remote
        return repo_ref
    return f"https://{repo_ref}"


def _external_bases(dockerfile_path: Path) -> list[str]:
    """External `FROM` base images in the Dockerfile, in order, de-duplicated.

    Skips `scratch`, references to an earlier build stage (`AS <name>`), and
    build-arg-templated bases (`FROM $BASE`) — none of which is an external pull the
    mirror must preload. Raises `ProvisionError` if the Dockerfile is missing."""
    if not dockerfile_path.is_file():
        raise ProvisionError(
            f"no {dockerfile_path.name} in the repo build context"
        )
    stages: set[str] = set()
    bases: list[str] = []
    for raw in dockerfile_path.read_text(encoding="utf-8").splitlines():
        tokens = raw.strip().split()
        if len(tokens) < 2 or tokens[0].upper() != "FROM":
            continue
        image = tokens[1]
        alias = tokens[3] if len(tokens) >= 4 and tokens[2].upper() == "AS" else None
        external = not (image.lower() == "scratch" or image in stages or image.startswith("$"))
        if external and image not in bases:
            bases.append(image)
        if alias is not None:
            stages.add(alias)
    return bases


def _mirror_dst(base: str, mirror_endpoint: str) -> str:
    """Where `--registry-mirror` will look for `base`, so the preload lands there.

    Kaniko's mirror swaps the source registry host for the mirror host, keeping the
    docker-normalized repository path and the tag/digest. So a base with an explicit
    host (`ghcr.io/org/img:tag`) drops the host; a bare docker-hub name gains the
    `library/` prefix if it is single-component (`busybox` -> `library/busybox`)."""
    repo, suffix = _split_ref(base)
    first, slash, rest = repo.partition("/")
    if slash and ("." in first or ":" in first or first == "localhost"):
        repository = rest  # explicit registry host — drop it
    elif "/" not in repo:
        repository = f"library/{repo}"  # docker-hub short name
    else:
        repository = repo  # docker-hub user/repo
    return f"{mirror_endpoint}/{repository}{suffix}"


def _split_ref(ref: str) -> tuple[str, str]:
    """Split an image ref into (name, suffix) where suffix is `:tag` or `@digest`.

    A `:` counts as a tag separator only after the last `/` (else it is a registry
    host port). No tag and no digest defaults to `:latest`, matching normalization."""
    if "@" in ref:
        name, digest = ref.split("@", 1)
        return name, f"@{digest}"
    colon = ref.rfind(":")
    if colon > ref.rfind("/"):
        return ref[:colon], ref[colon:]
    return ref, ":latest"


def _pack_context(repo_root: Path) -> Mapping[str, str]:
    """Pack the cloned repo into the ConfigMap `data` map (relative posix path -> text).

    Skips the `.git` metadata dir; enforces the 1 MiB ConfigMap ceiling, failing
    closed (`ProvisionError`) on oversize or on a non-UTF-8 file — both cases point at
    the deferred git-mirror Pod, the scale path for large/binary contexts."""
    files: dict[str, str] = {}
    total = 0
    for path in sorted(repo_root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(repo_root)
        if ".git" in rel.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ProvisionError(
                f"build-context file {rel.as_posix()!r} is not UTF-8 text; the "
                "ConfigMap MVP packs text only — a binary context rides the deferred "
                "git-mirror Pod (deferred-open-items.md)"
            ) from exc
        total += len(text.encode("utf-8"))
        if total > _CONFIGMAP_MAX_BYTES:
            raise ProvisionError(
                f"build context exceeds the {_CONFIGMAP_MAX_BYTES}-byte ConfigMap "
                "ceiling; a larger repo rides the deferred git-mirror Pod "
                "(deferred-open-items.md)"
            )
        files[rel.as_posix()] = text
    return files


def _emit_config(ctx: EngagementContext, *, host: str, port: int) -> Mapping[str, str]:
    """The ConfigMap payload: scope.yaml (target host+port) + run.toml (M6a-shaped)."""
    scope_yaml = f"target:\n  host: {host}\n  ports: [{port}]\n"
    run_toml = config_gen.render_run_config(ctx, _SCOPE_BASENAME, _POD_OUTPUT_DIR)
    return {_SCOPE_BASENAME: scope_yaml, "run.toml": run_toml}
