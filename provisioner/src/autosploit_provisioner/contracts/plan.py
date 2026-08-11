"""plan — resolved-source + build-plan shapes (docs/provisioner.md §4 rows 1-2).

Frozen hand-offs between the early slices: `source` resolves a repo ref into a
`Source`; `build.resolver` turns a workdir into a `BuildPlan`; `build.booter`
consumes the plan. Detection results only — no side effects carried here.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

SourceKind = Literal["git", "local", "image"]
BuildBranch = Literal["dockerfile"]  # Phase A: Dockerfile only. compose/buildpacks deferred (§9)


@dataclass(frozen=True, slots=True)
class Source:
    """A resolved repo reference (docs/provisioner.md §4 row 1).

    `kind` picks how it was resolved; `path` is the workdir (git/local) or None
    for a prebuilt image; `image_ref` is set only for kind="image"; `commit` is
    the sha when known (git repo), else None. The clone token is NEVER stored
    here or anywhere on disk (§8).
    """

    kind: SourceKind
    path: Path | None
    image_ref: str | None
    commit: str | None


@dataclass(frozen=True, slots=True)
class BuildPlan:
    """How to produce a runnable image (docs/provisioner.md §4 row 2).

    Phase A has one branch: build the `dockerfile` in `context`. For an
    already-built image the resolver is skipped and the booter runs it directly.
    """

    branch: BuildBranch
    context: Path
    dockerfile: Path
