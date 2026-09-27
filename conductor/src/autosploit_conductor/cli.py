"""CLI — `conductor run <repo> [--engagement-id <id>] [--out <dir>] [--timeout-s <s>]` (docs/conductor.md §7 cli.py).

One entrypoint closes the vertical slice: repo → running target → autonomous
exploit → report → cleanup. On success prints the machine-parseable
`report=…` / `record=…` lines for the future control plane (§5).

Exit codes (C5): 0 on complete **and** partial (a halted run still produced a
report — the control plane distinguishes them via the record, not the exit
code), non-zero on failed(provision)/failed(harness) and on internal errors.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from autosploit_conductor.context import ConductorError


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point. 0 = complete or partial; 1 = failed(provision)/failed(harness)."""
    args = _parse_args(argv)
    try:
        if args.k8s:
            result, record_path = _run_k8s(args)
        else:
            # Lazy import: the Phase A path pulls in the provisioner teardown,
            # so importing the CLI (and the Phase B path) doesn't depend on it.
            from autosploit_conductor.run import run

            result, record_path = run(
                args.repo,
                engagement_id=args.engagement_id,
                out_dir=args.out,
                timeout_s=args.timeout_s,
            )
    except ConductorError as exc:
        print(f"conductor: {exc}", file=sys.stderr)
        return 1

    if result.report_path is not None:
        print(f"report={result.report_path}")
    if record_path is not None:
        print(f"record={record_path}")

    return 0 if result.status in ("complete", "partial") else 1


def _run_k8s(args: argparse.Namespace) -> tuple[object, Path | None]:
    """Phase B path — drive the cluster (roadmap M6). Imported lazily so the

    Phase A path never needs the kubernetes SDK. The M8 provisioner (Kaniko
    in-cluster build) drives the cluster through the same EngagementCluster the
    orchestrator holds, so it is passed as the injected provision seam with the
    operator-supplied target port bound in.
    """
    import functools
    import os

    from autosploit_conductor.context import ContextError
    from autosploit_conductor.k8s import helm
    from autosploit_conductor.k8s.factory import build_core_v1, build_custom_objects
    from autosploit_conductor.k8s.provision import phaseb_provision
    from autosploit_conductor.k8s.run import _DEFAULT_CHART_DIR, run_k8s

    if args.target_port is None:
        raise ContextError("--k8s requires --target-port (the port the target listens on)")

    api = build_core_v1()
    custom = build_custom_objects()
    provision = functools.partial(phaseb_provision, target_port=args.target_port)
    # The engagement workload is a Helm release rendered from the per-engagement
    # chart (M9). Default to the in-repo chart; AUTOSPLOIT_ENGAGEMENT_CHART overrides
    # it (e.g. a chart baked into the conductor image at a different path).
    chart_override = os.environ.get("AUTOSPLOIT_ENGAGEMENT_CHART")
    chart_dir = Path(chart_override) if chart_override else _DEFAULT_CHART_DIR
    return run_k8s(
        args.repo,
        api,
        provision=provision,
        custom=custom,
        engagement_id=args.engagement_id,
        out_dir=args.out,
        helm=helm,
        chart_dir=chart_dir,
        timeout_s=args.timeout_s,
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="conductor",
        description=(
            "Own one engagement end to end: provision the target, run the harness "
            "against it, collect the report, tear everything down (docs/conductor.md §1)."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="run one engagement from a repo ref")
    run_p.add_argument("repo", help="repo ref: git URL, local path, or image ref")
    run_p.add_argument(
        "--engagement-id",
        default=None,
        help="engagement id (docker-label charset [a-zA-Z0-9_.-]+); defaults to a fresh uuid hex",
    )
    run_p.add_argument(
        "--out",
        type=Path,
        default=Path("."),
        help="base out-dir; the engagement workdir is <out>/<engagement-id> (default: .)",
    )
    run_p.add_argument(
        "--timeout-s",
        type=float,
        default=None,
        help="wall-clock timeout for the whole run (provision + harness); generous by default",
    )
    run_p.add_argument(
        "--k8s",
        action="store_true",
        help="Phase B: run the engagement on a Kubernetes cluster (namespace per "
        "engagement, gVisor Pods, Service) instead of local subprocesses (roadmap M6)",
    )
    run_p.add_argument(
        "--target-port",
        type=int,
        default=None,
        help="Phase B (--k8s): the port the built target listens on (M8). Required "
        "with --k8s: a Dockerfile repo does not reliably declare it, so the operator "
        "supplies it; it becomes the scope port the attacker is allowed to reach.",
    )

    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
