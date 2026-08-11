# autosploit-provisioner

Turns a repo reference into a running target **plus** an immutable `scope.yaml`
the harness can consume, then tears it down. The scope file is the only contract
with the harness; everything else is internal.

Build spec + roadmap: [`../docs/provisioner.md`](../docs/provisioner.md).
Companion: [`../docs/orchestration.md`](../docs/orchestration.md).

## Trust boundary (load-bearing)

The provisioner builds and runs code we did not write — untrusted-input handling.
It **never holds secrets** and never sees the model API key (that's the
conductor's job). See `docs/provisioner.md §2`.

## Layout (vertical-slice, mirrors `../harness`)

```
src/autosploit_provisioner/
├─ contracts/   # SEAM: frozen shapes + error root, no logic. Nothing imports a slice.
├─ source/      # [1] repo ref → workdir + commit sha (token-safe)
├─ build/       # [2] resolver: detect branch  ·  [3] booter: build + run labeled container
├─ discovery/   # [4] health poll + published-port inspect
├─ emit/        # [5] scope.yaml (self-validate via harness load_scope)  ·  [6] provision.json
├─ teardown/    # [7] rm-by-label, idempotent, atexit/signal
├─ provision.py # orchestrate 1..7 → ProvisionResult
└─ cli.py       # provision <repo> --engagement-id <id> --out <dir>
```

Slices touch each other only through the frozen shapes in `contracts/` — the same
one-way dependency rule the harness uses.

## Dev

```bash
uv sync
uv run pytest            # pure suite (no Docker)
uv run pytest -m integration   # needs a Docker daemon (M3+)
```
