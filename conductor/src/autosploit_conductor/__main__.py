"""Allow `python -m autosploit_conductor` to reach the CLI entrypoint."""

from autosploit_conductor.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
