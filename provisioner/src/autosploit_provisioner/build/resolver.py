"""resolver — workdir → BuildPlan, with the §8 reject ladder (docs/provisioner.md §4 row 2, M1).

Pure and Docker-free so the fast test suite runs with no daemon. Phase A supports a
single build branch — a `Dockerfile` in the workdir root — and rejects everything
else with the exact §8 strings the CLI/conductor pin against:

  1. `Dockerfile` is a real file            → `BuildPlan(branch="dockerfile", …)`.
  2. no Dockerfile, a compose file present  → `UnsupportedBuild("compose deferred, …")`.
  3. neither                                → `UnsupportedBuild("no Dockerfile; …")`.

Dockerfile wins when both it and a compose file sit in the dir (documented
precedence); a `Dockerfile` that is a *directory* is not a usable file and falls
through to the no-Dockerfile reject.
"""

from __future__ import annotations

from pathlib import Path

from ..contracts.errors import UnsupportedBuild
from ..contracts.plan import BuildPlan

# compose filenames Docker itself honors — any of these, without a Dockerfile, is the
# deferred compose branch (§9), not a hard "nothing to build".
_COMPOSE_FILENAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")


def resolve_build(workdir: Path) -> BuildPlan:
    """Resolve `workdir` into a `BuildPlan`, or raise the matching §8 `UnsupportedBuild`.

    A root `Dockerfile` (a real file) yields the Phase-A dockerfile plan and takes
    precedence over any compose file. Otherwise a compose file present means the
    deferred branch; an empty/Dockerfile-less dir means nothing to build.
    """
    dockerfile = workdir / "Dockerfile"
    if dockerfile.is_file():
        return BuildPlan(branch="dockerfile", context=workdir, dockerfile=dockerfile)

    if any((workdir / name).exists() for name in _COMPOSE_FILENAMES):
        raise UnsupportedBuild("compose deferred, Dockerfile only for MVP")

    raise UnsupportedBuild("no Dockerfile; nothing to build")
