"""cli — `provision <repo> --engagement-id <id> --out <dir>` (docs/provisioner.md §5, M6).

Thin wrapper over `provision.provision(...)`: parse args, run the chain, and on
success print the two artifact paths in a machine-parseable `key=value` shape so the
conductor can chain provisioner → harness without scraping prose:

    scope=/…/scope.yaml
    manifest=/…/provision.json

Any reject/failure is caught as a `ProvisionError`, its §8 message printed to stderr,
and the process exits non-zero. `provision()` has already torn down by then, so a
failed run leaves no orphan. `main` is the `[project.scripts]` entry point (a console
script wraps it as `sys.exit(main())`, so the returned int is the exit code).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from .contracts.errors import ProvisionError
from .provision import provision


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point. Returns 0 on success, 1 on any provisioner reject/failure (§8)."""
    args = _parse_args(argv)
    try:
        result = provision(args.repo, args.engagement_id, args.out)
    except ProvisionError as err:
        print(str(err), file=sys.stderr)
        return 1

    # Machine-parseable handoff for the conductor (§5).
    print(f"scope={result.scope_path}")
    print(f"manifest={result.manifest_path}")
    return 0


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="provision",
        description="Turn a repo ref into a running target + a harness-valid scope.",
    )
    parser.add_argument("repo", help="repo ref: git URL, local path, or image ref")
    parser.add_argument(
        "--engagement-id", required=True, help="engagement id; labels every artifact"
    )
    parser.add_argument(
        "--out", required=True, help="output dir for scope.yaml + provision.json"
    )
    return parser.parse_args(argv)


if __name__ == "__main__":  # `python -m autosploit_provisioner.cli`
    raise SystemExit(main())
