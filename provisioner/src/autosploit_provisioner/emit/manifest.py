"""manifest — write provision.json (docs/provisioner.md §4 row 6, §8, M5).

`write_manifest(out, ...)` records the run for debug + teardown: engagement id,
repo ref + commit sha, build branch taken, image tag, container id(s), published
host ports, scope path, and ISO timestamps. It is a pure record of what the
pipeline already produced — it holds no logic and touches no daemon.

**No token, ever (§8).** The clone token lives only in the cloner's memory and is
never carried in a `Source`, so nothing token-bearing reaches this function; the
manifest records the repo ref as given by the caller.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path


def write_manifest(
    out: Path,
    *,
    engagement_id: str,
    repo_ref: str,
    commit: str | None,
    build_branch: str,
    image_tag: str,
    container_ids: Sequence[str],
    ports: Sequence[int],
    scope_path: Path,
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
) -> Path:
    """Write `provision.json` to `out` and return `out`.

    `started_at`/`finished_at` default to now (UTC); all timestamps are serialized
    as ISO-8601 strings. Never records a token (§8).
    """
    now = datetime.now(UTC)
    record = {
        "engagement_id": engagement_id,
        "repo_ref": repo_ref,
        "commit": commit,
        "build_branch": build_branch,
        "image_tag": image_tag,
        "container_ids": list(container_ids),
        "ports": [int(p) for p in ports],
        "scope_path": str(scope_path),
        "started_at": (started_at or now).isoformat(),
        "finished_at": (finished_at or now).isoformat(),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return out
