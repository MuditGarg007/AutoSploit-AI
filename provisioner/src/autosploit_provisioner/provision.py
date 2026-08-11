"""provision — orchestrate the pipeline (docs/provisioner.md §5, §10 step 7, M6).

`provision(ref, engagement_id, out_dir) -> ProvisionResult` is the single module
that knows the full order: cloner → resolver → booter → discovery → emitter →
manifest. Every slice stays unaware of the others (§4, contracts one-way rule);
only this function wires them.

**Teardown discipline (§8):** the whole chain runs inside a `try/except
BaseException`, so *any* failure — a reject, an unexpected error, or a Ctrl-C
mid-build — tears down (rm-by-label + owned workdir) before re-raising, leaving no
orphan. On **success we deliberately do NOT tear down**: the container must stay up
for the conductor to point the harness at (§5 HANDOFF). The caller runs teardown
after the engagement, not us.

Workdir ownership: only a `git`-cloned dir is ours to delete. A `local` path is the
caller's checkout and an `image` source has no workdir — for both, teardown removes
containers by label but never touches the caller's filesystem.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from .build.booter import boot, run_image
from .build.resolver import resolve_build
from .contracts.result import ProvisionResult
from .discovery import discover
from .emit import emit_scope, write_manifest
from .source.cloner import resolve_source
from .teardown import teardown

# Phase A binds the target on loopback; the harness scope pairs each published host
# port with this host (§3 — Phase B bumps it to Service DNS at contract 1.1.0).
HOST = "127.0.0.1"


def provision(ref: str, engagement_id: str, out_dir: str | Path) -> ProvisionResult:
    """Run the full provision chain for `ref`, writing scope + manifest under `out_dir`.

    Returns a frozen `ProvisionResult` (scope path, manifest path, host, ports,
    container ids) with the target still running for handoff. Raises the matching
    `ProvisionError` subclass (§8) on any reject/failure — after tearing down so no
    container or cloned workdir is left behind.
    """
    out_dir = Path(out_dir)
    started_at = datetime.now(UTC)

    # Only a dir we cloned into is ours to delete on teardown; None for local/image.
    owned_workdir: Path | None = None
    try:
        source = resolve_source(ref, out_dir / "src")
        if source.kind == "git":
            owned_workdir = source.path

        container, build_branch, image_tag = _build_and_run(
            source, ref, engagement_id
        )

        ports = discover(container)

        scope_path = emit_scope(HOST, ports.host, out_dir / "scope.yaml")
        manifest_path = write_manifest(
            out_dir / "provision.json",
            engagement_id=engagement_id,
            repo_ref=ref,
            commit=source.commit,
            build_branch=build_branch,
            image_tag=image_tag,
            container_ids=(container.id,),
            ports=ports.host,
            scope_path=scope_path,
            started_at=started_at,
            finished_at=datetime.now(UTC),
        )

        return ProvisionResult(
            engagement_id=engagement_id,
            scope_path=scope_path,
            manifest_path=manifest_path,
            host=HOST,
            ports=ports.host,
            container_ids=(container.id,),
        )
    except BaseException:
        # Any failure (reject, crash, or interrupt) tears down before propagating so
        # a half-run provision leaves no orphan (§8). Catching BaseException also
        # covers a Ctrl-C mid-build; the original error is re-raised untouched below.
        # Guarded so a teardown error — e.g. no Docker daemon — never masks it.
        try:
            teardown(engagement_id, owned_workdir)
        except Exception:  # noqa: BLE001,S110 — best-effort cleanup; original error re-raised regardless
            pass
        raise


def _build_and_run(source, ref: str, engagement_id: str):
    """Turn a `Source` into a running labeled container; return (container, branch, tag).

    Image sources skip the resolver+build (§4 row 1); git/local sources go through
    the Dockerfile ladder. `branch`/`tag` are recorded verbatim in the manifest.
    """
    if source.kind == "image":
        return run_image(source.image_ref, engagement_id), "image", source.image_ref

    plan = resolve_build(source.path)
    tag = f"autosploit-provisioner/{engagement_id}:latest"
    return boot(plan, tag, engagement_id), plan.branch, tag
