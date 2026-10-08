"""build — resolve a workdir into a BuildPlan, then build + run it (docs/provisioner.md §4 rows 2-3).

Two slices, one-way dependency (§4): `resolver` turns a workdir into a frozen
`BuildPlan` (pure, no Docker); `booter` consumes that plan to build the image and
run a labeled container (first Docker touch, M3). `ENGAGEMENT_LABEL` is re-exported
here because teardown (M5) keys off the very same label the booter stamps on.
"""

from __future__ import annotations

from .booter import ENGAGEMENT_LABEL, boot, run_image
from .resolver import resolve_build

__all__ = ["ENGAGEMENT_LABEL", "boot", "run_image", "resolve_build"]
