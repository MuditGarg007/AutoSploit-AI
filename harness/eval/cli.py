"""cli — the eval rig entrypoint (docs/harness.md §8, §9 step 4).

Two commands, both reading the same on-disk artifacts the dashboard would (§8):

    python eval/cli.py score <run_dir>
        Score one finished run against the documented solutions — coverage,
        cost, tool-call success (§6.1). Prints the ScoreCard JSON.

    python eval/cli.py sweep --config <run.toml> [--models a,b,c]
        Run the loop across models against the target in <run.toml>, score each,
        and recommend the primary from data (§8). Needs a live target +
        OPENROUTER_API_KEY; defaults to deepseek-v4-flash only (project decision).

Lives in eval/ (outside the package): it CONSUMES the driver, doesn't ship in it.
Runs as a script — it puts its own dir on sys.path so the sibling eval modules
(score/sweep/...) import cleanly, and reuses the driver CLI's .env loader so a
live sweep finds the key.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling eval modules

from score import score_run
from sweep import DEFAULT_MODELS, sweep


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="autosploit-eval")
    sub = parser.add_subparsers(dest="command", required=True)

    score_p = sub.add_parser("score", help="score one finished run directory")
    score_p.add_argument("run_dir", type=Path, help="path to a run directory")

    sweep_p = sub.add_parser("sweep", help="run + score a model sweep, pick the primary")
    sweep_p.add_argument("--config", required=True, type=Path, help="base run.<name>.toml")
    sweep_p.add_argument(
        "--models",
        type=str,
        default=",".join(DEFAULT_MODELS),
        help="comma-separated OpenRouter model ids (default: flash only)",
    )

    args = parser.parse_args(argv)

    if args.command == "score":
        card = score_run(args.run_dir)
        print(json.dumps(card.to_dict(), indent=2))
        return 0

    if args.command == "sweep":
        _load_env()
        models = tuple(m.strip() for m in args.models.split(",") if m.strip())
        result = sweep(args.config, models=models)
        print(json.dumps(result.to_dict(), indent=2))
        print(f"\n=== primary: {result.primary} — {result.rationale} ===", file=sys.stderr)
        return 0

    return 1


def _load_env() -> None:
    """Reuse the driver CLI's .env loader so a live sweep finds OPENROUTER_API_KEY."""
    try:
        from autosploit_harness.cli import _load_dotenv
    except ImportError:
        return
    _load_dotenv()


if __name__ == "__main__":
    raise SystemExit(main())
