"""CLI entrypoint — `autosploit-harness run --config configs/run.example.toml`.

Thin argparse/typer shell over `driver.run`. Parses flags (config path, scope
file, output dir, dry-run), hands a typed config to the driver, streams events
to stdout. No orchestration logic lives here — the driver owns the run (§1).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _load_dotenv(start: Path | None = None) -> None:
    """Load KEY=VALUE lines from the nearest .env (cwd upward) into os.environ.

    Minimal, dependency-free. Never overrides a variable already set in the
    environment — an explicit export wins over the file.
    """
    here = (start or Path.cwd()).resolve()
    for directory in (here, *here.parents):
        env_file = directory / ".env"
        if not env_file.exists():
            continue
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)
        return


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    parser = argparse.ArgumentParser(prog="autosploit-harness")
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="run an engagement from a config file")
    run_p.add_argument("--config", required=True, type=Path, help="path to run.<name>.toml")

    contract_p = sub.add_parser(
        "contract", help="write the frozen seam descriptor (contracts/contract.schema.json)"
    )
    contract_p.add_argument(
        "--out", type=Path, default=None, help="output path (default: contracts/contract.schema.json)"
    )

    args = parser.parse_args(argv)

    if args.command == "run":
        from autosploit_harness.driver.run import run

        report = run(args.config)
        status = "COMPLETE" if report.completed else f"PARTIAL ({report.halt_reason})"
        print(
            f"\n=== engagement {status} — {report.turns} turns, "
            f"{report.tool_results} tool results, {report.budget['tool_calls']} tool calls ===",
            file=sys.stderr,
        )
        return 0 if report.completed else 2

    if args.command == "contract":
        from autosploit_harness.contracts.export import write_contract
        from autosploit_harness.contracts.version import CONTRACT_VERSION

        out = write_contract(args.out) if args.out else write_contract()
        print(f"contract v{CONTRACT_VERSION} written to {out}", file=sys.stderr)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
