# Autosploit — Conductor

Owns one engagement end to end: provision the target, launch the harness against
it, collect the report, tear everything down — on success, failure, or
interruption (see `docs/conductor.md`).

Phase A is a thin local conductor: plain subprocesses + Docker, no Kubernetes.

```
uv sync
uv run conductor run <repo> [--engagement-id <id>] [--out <dir>]
```

## C6 — first real end-to-end run (done)

One command closes the vertical slice: `repo → running app → autonomous exploit →
report → cleanup` (docs/conductor.md §10 step 6, C6).

```
# key must be in the conductor's process env; it is injected into the harness
# subprocess only (never the provisioner, never disk — §2 trust boundary)
export OPENROUTER_API_KEY=sk-or-...   # or set it on the command line
uv run conductor run https://github.com/juice-shop/juice-shop.git \
  --engagement-id juiceshop --out ./runs
```

What the run proved (gate: conductor-driven chain, provisioner-stood-up target,
report produced, zero residue):

- **Provision** — the provisioner cloned Juice Shop, built its Dockerfile, and
  left the target up with a published host port; emitted `scope.yaml` +
  `provision.json` handoff parsed by the conductor.
- **Exploit** — the harness ran against the *provisioned* scope with
  `OPENROUTER_API_KEY` injected; streamed events showed SQLi probing, an admin
  JWT login, B2B order injection, and `/ftp` probing — the M7 finding classes.
  Runs halted on the budget cap (exit 2 = partial, still a report), matching the
  M7 baseline's partial/token-cap outcome.
- **Report** — `runs/<timestamp>/report.json` was produced and correctly located
  by the conductor (both the direct and timestamped-subdir layouts are honored).
- **Teardown** — the target container is removed by label and the engagement
  out-dir deleted; only `conductor.json` survives (the Phase A stand-in for the
  control-plane Postgres row). The out-dir removal retries on transient Windows
  file locks so a cloned git pack file can't leak residue.

The surviving artifact is the run record:

```
--out/<engagement-id>/conductor.json   # statuses, report path, timestamps
```
