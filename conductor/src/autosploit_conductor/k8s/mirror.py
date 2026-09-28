"""In-cluster base-image mirror — the crane-copy helper (M5, roadmap M8 "Open → M5").

Under the live M7 default-deny egress the Kaniko build Pod can reach no external
base-image registry, so a `FROM <external>` pull is denied. The conductor, which
*does* have egress, closes that gap by preloading each external base into the
per-engagement in-cluster registry before the build runs; Kaniko then resolves the
`FROM` against that registry via `--registry-mirror` and never touches the network
(`manifests.kaniko_build_pod_manifest`, `provision.phaseb_provision`).

`mirror_base_image` is the one place the conductor shells out to `crane copy`, and it
is *injected* into `phaseb_provision` (default: this function) so the whole provision
flow unit-tests against a fake with no crane and no network — the same seam the clone
(`resolve_source`) and the cluster calls use. crane talks the registry HTTP API
directly, so there is **no docker socket** anywhere in this path; crane is baked into
the conductor image (M5 Phase 6).
"""

from __future__ import annotations

import subprocess


class MirrorError(RuntimeError):
    """A base-image copy into the in-cluster mirror failed.

    Raised so `phaseb_provision` records a clean `failed(provision)` (the target
    never came up) rather than crashing — the same fail-closed contract the clone
    and the ConfigMap ceiling follow.
    """


def mirror_base_image(src: str, dst: str, *, insecure: bool = True) -> None:
    """`crane copy src dst` — preload one base image into the in-cluster mirror.

    `src` is the external base ref (`busybox:1.36`, `ghcr.io/org/base:tag`), pulled
    with the conductor's egress; `dst` is the ref inside the per-engagement registry
    the build later pulls from via `--registry-mirror`. The dest is plain HTTP inside
    the cluster, so `--insecure` is passed (mirroring the Kaniko push side, which is
    `--insecure` for the same reason). Raises `MirrorError` on any crane failure.
    """
    args = ["crane", "copy"]
    if insecure:
        # Global crane flag: permit plain-HTTP / unverified TLS. Needed for the dest
        # (the in-cluster registry serves plain HTTP); the external src still uses
        # TLS when it offers it — insecure only *permits* the plain path, it does
        # not force it.
        args.append("--insecure")
    args += [src, dst]
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise MirrorError(
            f"crane copy {src} -> {dst} failed: {result.stderr.strip()}"
        )
