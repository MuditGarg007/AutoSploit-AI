# Autosploit — Conductor (spec)

> **Status: design (2026-08-10).** Build spec for the **conductor** (overview §3
> plane 3). This is the last missing piece of the overview §6 step-1 vertical
> slice: the provisioner (built) stands up the target, the harness (built) attacks
> it, and the conductor chains them into one run that always tears down. Companion
> to `docs/orchestration.md` (which places the conductor next to the provisioner
> and the k8s isolation model). This doc is the conductor's own build order, in
> the spirit of `docs/provisioner.md §11` and `docs/harness.md §9`.

---

## 1. One-line job

**Own one engagement end to end: provision the target, launch the harness against
it, collect the report, tear everything down — on success, failure, or
interruption.** The conductor is the only component that holds the model API key
and the only one allowed to hand it to the harness (trust boundary,
`orchestration.md §2`).

---

## 2. Scope of THIS component

**In scope (Phase A — thin local conductor):**
- Create an engagement workdir / output dir.
- Invoke the provisioner (as a subprocess); read its machine-parseable
  `scope=…` / `manifest=…` handoff.
- Generate a harness run config that points at the *emitted* scope (the one seam).
- Inject `OPENROUTER_API_KEY` into the harness process environment (the one secret).
- Run the harness; stream its stdout/event stream through; wait for the report.
- **Teardown: always.** Remove the provisioner's target container(s) and the
  engagement workdir — on completion, on failure, and on SIGINT/SIGTERM.
- Emit a small `conductor.json` run record (engagement id, exit statuses, report
  path, timestamps) — the Phase A stand-in for what the control plane will later
  read from Postgres.

**Out of scope (belongs elsewhere — do NOT build here):**
- Building/running the target, emitting scope → **provisioner** (untrusted; never
  sees the key). The conductor invokes it as a subprocess and never reaches into
  its internals.
- The attack loop, tool calls, the agent → **harness**. The conductor runs it as a
  subprocess and watches it; it does not orchestrate the loop.
- Kubernetes, Namespace/Pod/Service, NetworkPolicy, gVisor, Kaniko, Helm → **Phase
  B** (`orchestration.md §9`). This doc is plain local subprocesses + Docker.
- Auth / GitHub OAuth / repo picker / Redis queue / live dashboard / quotas →
  control plane (overview §6 step 2+).
- Multi-engagement concurrency, namespace TTL, per-user caps → Phase B/C.

**Trust boundary (load-bearing):** the conductor is the **trusted** half of the
pair. It holds the `OPENROUTER_API_KEY`; the provisioner must never see it. In
Phase A that means: the key goes only into the harness subprocess environment —
never into the provisioner invocation, never into any file the provisioner could
read (no `.env` in the shared workdir), never into the manifest or logs.

---

## 3. The frozen seams — the two interfaces the conductor plugs into

The conductor is defined entirely by two existing interfaces. Match them exactly;
do not reshape them.

### 3.1 Seam A — the provisioner CLI (in, `provisioner/src/autosploit_provisioner/cli.py`)

```
provision <repo> --engagement-id <id> --out <dir>
```

On success it prints, to stdout, exactly two machine-parseable lines:

```
scope=/abs/…/scope.yaml
manifest=/abs/…/provision.json
```

Facts that drive the conductor design (verified in the code):
- **On success the target container stays up** — the provisioner deliberately does
  NOT tear down, because the harness must be pointed at the running target
  (`provision.py` docstring). **Teardown is the conductor's job.**
- On any reject/failure the provisioner exits non-zero **after tearing itself
  down** — no orphan. The conductor should treat non-zero as "target never came
  up; nothing to clean."
- The scope file it writes is `target: {host: 127.0.0.1, ports: […]}` — Phase A
  contract `1.0.0`. The harness's own `load_scope` is the self-validation, done by
  the provisioner (§3 of its doc) — the conductor does not re-parse it.
- A `git` source clones into `<out>/src` — that workdir is owned by the run and is
  the conductor's to delete at teardown.

### 3.2 Seam B — the harness CLI (out, `harness/src/autosploit_harness/cli.py`)

```
autosploit-harness run --config <run.<name>.toml>
```

- Exit `0` = run completed (full report); exit `2` = partial (halted by budget/
  scope/refusal — still a report); non-zero otherwise.
- Needs `OPENROUTER_API_KEY` in the environment (gateway/client.py).
- The run config is a TOML with `[model]`, `[budget]`, `[target]`, `[output]`
  (see `harness/configs/run.example.toml`).

**The one subtlety (do not trip on it):** `[target].scope_file` is resolved
**relative to the run.toml's own directory**, not to the cwd. So the conductor
must write the generated run.toml **into the same out-dir as the emitted
scope.yaml**, and set `scope_file = "scope.yaml"` (relative), not an absolute
path. This is the single most likely wiring bug in this component.

---

## 4. Components & tasks

| # | Component | Tasks | Phase A form |
|---|-----------|-------|--------------|
| 1 | **Run context** | create engagement out-dir; generate `engagement_id` if not given; validate it is safe as a docker label / dir name (label charset: `[a-zA-Z0-9_.-]`, no empty) | `Path.mkdir` + regex |
| 2 | **Provisioner invocation** | subprocess `provision <repo> --engagement-id <id> --out <dir>`; parse the two stdout lines; on non-zero, surface stderr and fail (provisioner already cleaned up) | `subprocess.run` |
| 3 | **Run-config generator** | write `run.<id>.toml` in the **same out-dir** as scope.yaml: `[model]` defaults (DeepSeek flash / high / empty fallbacks for eval-style attribution), `[budget]` caps, `[target].scope_file = "scope.yaml"` (relative), `[output].dir = <out>/runs` | TOML writer |
| 4 | **Attacker launcher** | build the harness env: inherit + inject `OPENROUTER_API_KEY` (from env / .env, never printed); `autosploit-harness run --config run.<id>.toml`; stream child stdout+stderr through to our stdout; capture exit code | subprocess + env |
| 5 | **Watcher / result** | exit 0 → completed report at `runs/report.json`; exit 2 → partial report + halt reason (still success for the conductor's purposes); other non-zero → run failed | exit-code mapping |
| 6 | **Teardown** | always: call the provisioner's own `teardown(engagement_id, workdir)` (import directly — idempotent rm-by-label, `provisioner/…/teardown.py`); remove the engagement out-dir; registered on atexit + SIGINT/SIGTERM; a second run is a no-op | import + `register()` |
| 7 | **Run record** | write `conductor.json`: engagement id, repo ref, provision exit, harness exit, report path (or failure reason), timestamps. Phase A stand-in for the future control-plane Postgres row | `json` |

---

## 5. Flow / architecture

```
INPUT: repo ref + [--engagement-id] + [--out]
   │
   ▼
[1 context]  mkdir out/ ; validate engagement id ─────────────► out/<id>/
   │
   ▼
[2 provisioner]  subprocess: provision <repo> --engagement-id <id> --out out/
   │              parse "scope=…" + "manifest=…" (target stays up)
   ▼
[3 generator]  write run.<id>.toml in SAME dir as scope.yaml
   │            scope_file = "scope.yaml" (relative — the subtlety)
   ▼
[4 launcher]  env += OPENROUTER_API_KEY ; autosploit-harness run --config run.<id>.toml
   │              stream events through
   ▼
[5 result]  exit 0 → complete | exit 2 → partial | else → failed
   │
   ▼   ═══════════ the run is over, regardless of outcome ═══════════
[6 teardown]  provisioner.teardown(<id>)  → rm containers by label
   │              rm -rf out/<id>/        → owned workdir
   ▼
[7 record]  write conductor.json (statuses, report path, timestamps)
```

Phase-A entrypoint idea: `conductor run <repo> --engagement-id <id> --out <dir>`
-> prints `report=…` + `record=…`. This is the one command that closes the
vertical slice: `repo → running app → autonomous exploit → report → cleanup`.

---

## 6. Tech stack

Python 3.12 — match both siblings (`.python-version`), same `uv` project style.
The conductor is **trusted code** — it imports from *both* siblings by path dep,
which is exactly the trust split the docs want: the provisioner stays a black box
(only its public teardown is reused), the harness stays a black box (only its CLI
is called).

| Concern | Pick | Why |
|---------|------|-----|
| Project | `uv`, `pyproject.toml` sibling of `harness/` + `provisioner/` | matches both; one-tool repo |
| Harness contract | path dep on `autosploit-harness` (for `contracts` if needed later) | seam via the real package, not a copy |
| Provisioner teardown | path dep on `autosploit-provisioner` → import `teardown` | idempotent rm-by-label, the only provisioner surface the conductor touches |
| Subprocesses | stdlib `subprocess` | provisioner + harness are CLIs; no need for a task runner |
| Run config | stdlib `tomllib` to validate the generated toml round-trips | fail fast if the harness's parser rejects it |
| Typed result | `dataclass(frozen)` `RunResult` | match the harness/provisioner idiom |
| Tests | `pytest` + `ruff` dev group | mirror both rigs |
| Docker | **not a dependency** | the conductor never talks to Docker directly — teardown is delegated to the provisioner's import |

Phase B adds: `kubernetes` python client, Helm, and the conductor becomes a k8s
job controller (`orchestration.md §6, §8`).

---

## 7. Package layout (proposed)

Sibling of `harness/` and `provisioner/`, own `uv` project, depends on both for
the seams:

```
conductor/
├─ pyproject.toml            # uv project; path-deps on harness + provisioner
├─ src/autosploit_conductor/
│  ├─ context.py             # [1] out-dir + engagement-id validation
│  ├─ provision.py           # [2] subprocess the provisioner CLI; parse handoff
│  ├─ config_gen.py          # [3] run.<id>.toml (scope_file relative!)
│  ├─ launch.py              # [4] harness subprocess + env injection + streaming
│  ├─ result.py              # [5] exit-code → RunResult (complete/partial/failed)
│  ├─ teardown.py            # [6] wrapper over provisioner teardown + rm out-dir
│  ├─ record.py              # [7] conductor.json
│  ├─ run.py                 # orchestrates 1..7, returns RunResult
│  └─ cli.py                 # `conductor run <repo> --engagement-id --out`
└─ tests/
   ├─ test_context.py        # engagement-id validation, out-dir creation
   ├─ test_config_gen.py     # generated toml round-trips via tomllib; scope_file relative
   ├─ test_launch.py         # env injection (key present in child, never echoed)
   ├─ test_run.py            # end-to-end against a tiny fixture image (integration)
   └─ fixtures/              # tiny Dockerfile serving a port (reuse pattern from provisioner)
```

---

## 8. Error handling / edge cases

- **Provisioner exits non-zero** -> the provisioner already tore itself down; fail
  with its stderr surfaced, mark the run `failed(provision)`, still write the
  record + clean the out-dir. Nothing left to tear down.
- **`scope=`/`manifest=` lines missing or unparseable** -> fail closed; never
  launch the harness without a scope path. (Matches the provisioner's own
  fail-closed rule.)
- **Harness exits 2** -> that is a *partial* run with a report (budget/scope
  halt) — treat as success for the lifecycle: teardown + record the halt reason.
  Only genuinely non-zero-other is `failed(harness)`.
- **Harness never exits / hangs** -> Phase A accepts a wall-clock timeout (e.g.
  `--timeout-s`, default generous) that kills the child and proceeds to teardown;
  the report is marked partial-timeout. Phase B replaces this with Pod watch +
  namespace TTL.
- **Teardown must run no matter what** -> registered on atexit + SIGINT/SIGTERM
  (reuse the provisioner's `teardown.register` pattern); idempotent so a double
  call is a no-op. A crashed conductor leaves no target container and no out-dir.
- **Key hygiene (load-bearing, `orchestration.md §2`)** -> the key lives only in
  the harness subprocess env. Never in the provisioner env, never written to the
  out-dir, never echoed to our stdout. A `_redact` on any child output that might
  carry it (belt and braces — the harness doesn't echo it, but a leak must not
  propagate).
- **Engagement-id safety** -> validate against the docker label charset
  `[a-zA-Z0-9_.-]` before using it in a label/dir name; reject otherwise. No
  injection through an id into subprocess args (pass as argv, never a shell
  string).

---

## 9. Deferred / known limits

- **Kubernetes** — the entire Phase B surface (namespace per engagement, attacker
  + target Pods, Service, gVisor RuntimeClass, NetworkPolicy, Kaniko) is deferred
  by design (`orchestration.md §9 Phase B`). This doc's thin subprocess conductor
  is the throwaway proof that the *sequence* is right before the cluster earns its
  keep.
- **Harness in a container** — deferred to Phase B too. The harness image is worth
  packaging now (a `Dockerfile` for `harness/`, Phase B step 5 prep), but Phase A
  runs the harness as a local subprocess against `127.0.0.1` — containerizing the
  run early forces the scope `host` off loopback (contract bump 1.1.0) and weakens
  the egress story on Docker Desktop (Linux containers in a WSL2 VM; iptables
  rules get awkward). Subprocess keeps the proven M7 loop untouched.
- **Concurrency / quotas** — one engagement at a time in Phase A. Per-user caps +
  queue land in Phase C (control plane).
- **Live event streaming** — Phase A streams the harness's stdout through;
  structured SSE fan-out is the control plane's job (overview §3 plane 2).

---

## 10. Build order (this component)

1. **Context + config generator** — out-dir, id validation, run.toml generation
   with the relative-`scope_file` subtlety; tests first (pure, no subprocess).
2. **Provisioner invocation** — subprocess + handoff parsing (`scope=`/`manifest=`),
   fail-closed on missing lines; test with a fake provisioner script.
3. **Launcher + result mapping** — harness subprocess, env injection, streaming,
   exit-code → complete/partial/failed; test with a fake harness script.
4. **Teardown + record** — import provisioner teardown, rm out-dir, `register()`
   on atexit/signals; conductor.json. Idempotence test (call twice).
5. **run.py + cli.py** — wire 1..7; `conductor run <repo> --engagement-id
   --out`; `[project.scripts]` entry.
6. **First end-to-end conductor run** — provisioner-stood-up target (Juice Shop),
   harness exploits it, teardown leaves zero residue, all via **one command**.
   Closes overview §6 step-1 vertical slice for real (M7 was the manual proof;
   this is the repeatable one).

Then Phase B (`orchestration.md §9 Phase B`): local cluster → harness image + CI →
conductor as k8s controller → NetworkPolicy → Kaniko → Helm.

---

## 11. Build roadmap (detailed)

§10 is the one-line order. This section is the working plan: milestones with a
concrete goal, the files each touches, the steps, the tests, and a **gate** — the
observable condition that says the milestone is done and the next may start. Same
test-first spirit as `provisioner.md §11`; pure logic (config gen, id validation)
lands with tests before anything spawns a subprocess.

**Grounded facts (verified against the code, do not re-derive):**
- Seam A: `provisioner/src/autosploit_provisioner/cli.py` — `main(argv)` prints
  exactly `scope=<path>` then `manifest=<path>` on success, exits `1` on
  `ProvisionError`. On success the target **stays up** (provision.py docstring:
  "the container must stay up for the conductor"). Non-zero exit → already torn
  down.
- Seam B: `harness/src/autosploit_harness/cli.py` — `autosploit-harness run
  --config <toml>`; exit `0` complete / `2` partial / other = failure. Needs
  `OPENROUTER_API_KEY` in env.
- Teardown reuse: `provisioner/src/autosploit_provisioner/teardown/teardown.py` —
  `teardown(engagement_id, workdir=None)` idempotent rm-by-label on
  `label=engagement=<id>`; `register(engagement_id, workdir)` wires it to atexit +
  SIGINT/SIGTERM. The conductor imports these directly (trusted → trusted).
- Run-config shape: `harness/configs/run.example.toml` — `[model]` (id,
  reasoning, fallbacks), `[budget]` (max_usd, max_tokens, max_tool_calls),
  `[target]` (scope_file), `[output]` (dir). `driver/config.py` resolves
  `scope_file` **relative to the toml's directory**.

### C0 — Scaffold the sibling project (no logic)

**Goal:** an empty, installable `conductor/` next to `harness/` + `provisioner/`
that can import both siblings and run an empty test suite green.

- Create `conductor/` as a sibling (repo root has `docs/`, `harness/`,
  `provisioner/` today; add `conductor/` beside them).
- `conductor/pyproject.toml`: `name = "autosploit-conductor"`,
  `requires-python = ">=3.12"`, deps none beyond the path deps + dev group:
  ```toml
  [tool.uv.sources]
  autosploit-harness = { path = "../harness", editable = true }
  autosploit-provisioner = { path = "../provisioner", editable = true }

  [project]
  dependencies = ["autosploit-harness", "autosploit-provisioner"]

  [dependency-groups]
  dev = ["pytest>=9.1.1", "ruff>=0.16.2"]

  [tool.pytest.ini_options]
  pythonpath = ["src"]
  ```
- Create the package tree from §7 as empty modules (docstring only) so imports
  resolve. Add `conductor/.python-version` = `3.12`.
- **Gate:** `uv sync` succeeds; from inside `conductor/`, `uv run python -c
  "from autosploit_provisioner.teardown import teardown, register"` and `from
  autosploit_harness.driver.config import load_scope` both work; `uv run pytest`
  collects 0 tests and exits 0. Proves both path deps and the trust split — the
  one thing that can't be faked later.

### C1 — Context + run-config generator (pure, no subprocess)

**Goal:** a validated engagement context and a harness run.toml that round-trips.

- `context.py`: `EngagementContext` frozen dataclass `{engagement_id, out_dir,
  repo_ref, timeout_s}`; `make_context(repo_ref, engagement_id, out_dir) -> ...`
  — mkdir the out-dir, validate the id against `^[a-zA-Z0-9_.-]+$` (docker label
  charset), raise `ContextError` on bad id.
- `config_gen.py`: `write_run_config(context, scope_path) -> Path` — writes
  `run.<id>.toml` **in the same dir as scope_path**, with
  `scope_file = "scope.yaml"` (basename — relative, the subtlety), `[output].dir
  = <out>/runs`, model/budget defaults (flash, high, empty fallbacks, generous
  caps). **Self-validate: re-open with `tomllib` and assert the parsed shape.**
- Typed error root `ConductorError` — one base so the CLI catches cleanly.
- **Tests** (`test_context.py`, `test_config_gen.py`, tmp_path, no Docker):
  bad id rejected (`"../x"`, `"has space"`, empty); good id passes; generated
  toml round-trips via `tomllib`; `scope_file` is a bare relative basename and
  lives in the same dir as the scope; output dir lands under out-dir.
- **Gate:** every id-reject case asserted; generated toml parses and points
  `scope_file` at a relative name.

### C2 — Provisioner invocation (subprocess, no Docker of our own)

**Goal:** run the provisioner CLI, parse its handoff, fail closed.

- `provision.py`: `invoke_provision(repo_ref, ctx) -> Handoff` where `Handoff =
  {scope_path, manifest_path}`. `subprocess.run([...provision, repo_ref,
  --engagement-id, ctx.id, --out, ctx.out_dir])`, capture stdout+stderr, timeout
  `ctx.timeout_s`. Parse the two `key=value` lines. Rules: non-zero exit → raise
  `ProvisionFailed(stderr)` (provisioner already cleaned up); missing/unparseable
  line → raise `HandoffParseError` (fail closed, §8); never a shell string — argv
  list only.
- **Tests** (`test_provision.py`): fake `provision` script (a tiny py file that
  prints the two lines / exits non-zero / prints garbage) driven through a
  `--provision-cmd` seam (or monkeypatched PATH) — assert Handoff parsed, both
  fail paths raise the typed errors, stderr surfaced.
- **Gate:** happy path parses `scope=`/`manifest=`; both fail paths raise;
  fail-closed asserted (no handoff → error, not a default).

### C3 — Launcher + result mapping (subprocess + env)

**Goal:** run the harness against the generated config, inject the key, map exits.

- `launch.py`: `launch_harness(handoff, ctx, api_key) -> HarnessOutcome` —
  env = `os.environ` + `OPENROUTER_API_KEY=api_key`; `subprocess.run([...,
  "autosploit-harness", "run", "--config", run_toml])` streaming stdout/stderr
  through (`bufsize=1`, print as it arrives), timeout `ctx.timeout_s` → on
  timeout kill the child and mark `partial(timeout)`. **Key hygiene:** never
  print the key; `_redact(text, key)` scrubs it from any captured output before
  it hits our stdout (belt + braces, §8).
- `result.py`: map exit code → `RunResult` frozen dataclass
  `{status: Literal["complete","partial","failed"], report_path, halt_reason,
  exit_code}`: `0` → complete (report at `<out>/runs/report.json`); `2` →
  partial (read halt reason from the run record if present); other/timeout →
  failed/partial-timeout. `report_path` is `None` unless a report exists.
- **Tests** (`test_launch.py`): fake harness script that prints
  `OPENROUTER_API_KEY` presence to a file (assert injected, never on our stdout),
  echoes a line (assert streamed), exits 0/2/5 (assert mapping), sleeps past a
  tiny timeout (assert killed + partial-timeout). Key redaction asserted: a fake
  harness that echoes the key back → our captured stdout has it scrubbed.
- **Gate:** env injection proven (key in child, not on our stdout); 0/2/other
  mapped; timeout path kills and marks partial.

### C4 — Teardown + run record (the safety half)

**Goal:** guarantee cleanup and a machine-readable run record.

- `teardown.py`: thin wrapper — `teardown_run(ctx)` = provisioner's
  `teardown(ctx.engagement_id)` (rm-by-label; workdir deletion is covered by
  removing the whole out-dir) then `shutil.rmtree(ctx.out_dir,
  ignore_errors=True)`. `register(ctx)` wires it to atexit + SIGINT/SIGTERM
  (reuse the provisioner `register` pattern; or call the provisioner's own
  `register(id, workdir)` for the container half and register our own for the
  out-dir). Idempotent: second call is a no-op, not an error.
- `record.py`: `write_record(...)` → `conductor.json`: engagement id, repo ref,
  provision exit/status, harness exit/status, report path (or failure reason),
  `started_at`/`finished_at` ISO timestamps. No key, ever (§8).
- **Tests** (`test_teardown.py` integration, `test_record.py` pure): teardown
  removes a temp out-dir; second call no-ops; `register` + `os.kill(self,
  SIGINT)` style path leaves nothing (best-effort — at minimum assert the
  idempotence contract); record file contains the statuses and no key string.
- **Gate:** teardown leaves zero residue and is idempotent; record written on
  every terminal path.

### C5 — Orchestrator + CLI (wire 1..6)

**Goal:** one entrypoint runs the whole chain and always cleans up.

- `run.py`: `run(repo_ref, engagement_id, out_dir, api_key) -> RunResult` —
  sequence context → provision → config_gen → launch → result, with teardown in
  `try/finally` and record written last. The api_key is resolved **in `run`** from
  env (`OPENROUTER_API_KEY`) — the orchestrator is the only place that touches
  it.
- `cli.py`: `conductor run <repo> [--engagement-id <id>] [--out <dir>]
  [--timeout-s <s>]`; on success prints `report=…` + `record=…` (machine
  parseable, for the future control plane); non-zero exit on
  `failed(provision)`/`failed(harness)`, zero on complete **and** partial (a
  halted run still produced a report — the control plane distinguishes them via
  the record, not the exit code). Register as `[project.scripts]` entry.
- **Tests** (`test_run.py`, integration): fake provisioner + fake harness through
  the seam → full chain: record written, out-dir removed, statuses correct;
  failure injection (fake provisioner exits 1) → `failed(provision)`, out-dir
  removed, record written.
- **Gate:** `uv run conductor run <repo> --engagement-id t1 --out /tmp/e` chains
  fake provisioner → fake harness → teardown with correct statuses; failure path
  leaves zero residue.

### C6 — First real end-to-end run (closes overview §6 step-1 vertical slice)

**Goal:** one command: provision Juice Shop, exploit it, tear down, all via the
conductor — the repeatable version of M7.

- Point the conductor at a Juice Shop checkout (has a `Dockerfile`). It
  provisions (target container up), generates `run.juiceshop.toml` with
  `scope_file` relative, launches the harness with the injected key, streams the
  event feed, and tears down (no container, no out-dir) — all from one command.
- Compare the run's `report.json` against the M7 hand-run baseline (same exploit,
  same findings — proving the automated chain doesn't change the outcome).
- **Gate:** end-to-end run where the *chain* was conductor-driven end to end,
  target stood up by the provisioner, report produced, zero residue. This closes
  overview §6 step-1: `repo → running app → autonomous exploit → report → cleanup`
  as a single command.

### Milestone → gate summary

| M | Deliverable | Gate (done when…) | Subprocess needed |
|---|-------------|-------------------|:---:|
| C0 | scaffold + both path deps | `teardown` + `load_scope` import from inside `conductor/`; pytest green on 0 tests | no |
| C1 | context + config gen | id rejects asserted; toml round-trips; `scope_file` relative | no |
| C2 | provisioner invocation | handoff parsed; both fail paths raise typed errors | yes (fake) |
| C3 | launcher + result map | key in child env, never on stdout; 0/2/other mapped; timeout kills | yes (fake) |
| C4 | teardown + record | zero residue, idempotent; record on every terminal path | partial |
| C5 | orchestrator + CLI | one command chains fakes + tears down; failure leaves zero residue | yes (fakes) |
| C6 | real end-to-end | conductor-driven Juice Shop exploit + teardown, matches M7 baseline | yes (real) |

**Ordering rule:** C0–C1 are pure and land first (fast, deterministic). C2–C3
use tiny **fake** provisioner/harness scripts — no Docker, no network — so the
chain logic is proven deterministically before any real target. C4 needs a Docker
daemon for the container half (or defers it to the C6 integration run). C6 is the
real proof against Juice Shop. The relative-`scope_file` subtlety (C1) is the
component's contract with the harness — treat its test as non-negotiable.
