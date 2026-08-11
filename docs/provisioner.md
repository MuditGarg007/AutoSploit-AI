# Autosploit — Target Provisioner (spec)

> **Status: design (2026-08-08).** Build spec for the **target provisioner**
> (overview §4 plane 4). This is the deploy half of the overview §6 step-1 vertical
> slice — the attack half (harness) is already built. Companion to
> `docs/orchestration.md` (which places the provisioner next to the conductor and
> the k8s isolation model). This doc is the provisioner's own build order, in the
> spirit of `docs/harness.md §9`.

---

## 1. One-line job

**Turn a repo reference into a running target + an immutable scope file the harness
can consume, then tear it down.** The scope file is the only contract with the
harness; everything else is internal.

---

## 2. Scope of THIS component

**In scope:**
- Resolve a repo ref (git URL / local path / prebuilt image) into a running target.
- Build ladder (Phase A MVP): `Dockerfile` -> `docker build` + `run`. Neither
  Dockerfile nor compose -> reject.
- Health-check + discover published ports.
- Emit `scope.yaml` in the frozen format (`target: {host, ports}`).
- Emit `provision.json` manifest (debug + teardown record).
- Teardown: remove container(s), idempotent, always runs.

**Out of scope (belongs elsewhere — do NOT build here):**
- Launching the attacker / running the harness / holding the model API key
  -> **conductor** (trusted; see `docs/orchestration.md §6`). Provisioner handles
  untrusted repo code ONLY and must never see the key.
- Kubernetes, Kaniko, NetworkPolicy, gVisor -> **Phase B** (`orchestration.md §9`).
  Phase A is plain local Docker.
- Auth / GitHub OAuth / repo picker / queue -> control plane (overview §6 step 2+).
- compose branch, buildpacks, language detection -> deferred (§9).

**Trust boundary (load-bearing):** the provisioner builds and runs code we did not
write. It is untrusted-input handling. It never holds secrets. See
`orchestration.md §2`.

---

## 3. The frozen seam — how the handoff works (do not reshape)

The provisioner's output plugs into machinery that already exists in `harness/`.
Match it exactly.

**Scope file format** (`harness/configs/scope.juiceshop.yaml` is the reference):
```yaml
target:
  host: 127.0.0.1      # Phase A: loopback. Phase B: Service DNS (contract bump 1.1.0)
  ports: [3000]        # non-empty list of ints (published ports)
```

**Consumed by** `harness/src/autosploit_harness/driver/config.py::load_scope(path)`:
- requires a `target` mapping,
- requires non-empty `host` and non-empty `ports` list,
- returns frozen `ScopeAllowlist(host, ports)` (`contracts/scope.py`).

**Provisioner MUST self-validate** the file it writes by calling `load_scope` on it
before declaring the target ready. Fail-closed: if the emitted scope does not parse,
abort — never hand the harness an unparseable scope (mirrors harness §3 rule).

**Contract version:** currently `1.0.0` (single host + ports). Phase B changes
`host` from loopback IP to Service DNS = additive MINOR bump to `1.1.0`. Phase A
stays on `1.0.0`.

---

## 4. Components & tasks

| # | Component | Tasks | Phase A form |
|---|-----------|-------|--------------|
| 1 | **Repo cloner** | shallow `git clone --depth 1`; token from env, never logged, never in manifest; also accept local path + prebuilt-image shortcut | `git` subprocess |
| 2 | **Build resolver** | detect `Dockerfile` -> build branch; `docker-compose.yml`/`compose.yaml` -> deferred reject (§9); neither -> reject with clear message. Detection only | file existence check |
| 3 | **Booter** | `docker build -t <tag> .` then `docker run -d -P --label engagement=<id> <tag>`; `-P` auto-publishes exposed ports; label everything for teardown | docker-py + subprocess |
| 4 | **Health + port discovery** | poll container running/healthy (timeout + backoff); read published ports via `docker inspect` (`NetworkSettings.Ports`); pick web entrypoint | docker-py inspect |
| 5 | **Scope emitter** | write `target: {host: 127.0.0.1, ports: [...]}`; **self-validate via `load_scope`** before ready | PyYAML |
| 6 | **Manifest** | write `provision.json`: engagement id, repo ref + commit sha, build branch taken, image tag, container id(s), published ports, scope path, timestamps | json |
| 7 | **Teardown** | `docker rm -f` by `engagement=<id>` label; remove workdir; idempotent; runs on success, failure, SIGINT | docker-py + atexit/signal |

---

## 5. Flow / architecture

```
INPUT: repo ref (git url | local path | image) + engagement_id
   │
   ▼
[1 cloner] ── shallow clone / resolve local ─────────► workdir/ + commit sha
   │
   ▼
[2 resolver] ── Dockerfile? -> build  |  compose -> REJECT(deferred) | none -> REJECT
   │
   ▼
[3 booter] ── docker build -t <tag> . ; docker run -d -P --label engagement=<id>
   │
   ▼
[4 health+ports] ── poll running/healthy ; inspect NetworkSettings.Ports ─► {127.0.0.1: [ports]}
   │
   ▼
[5 emitter] ── write scope.yaml ; self-validate via load_scope ──► scope.yaml   ◄── FROZEN SEAM
   │
   ▼
[6 manifest] ── provision.json (id, commit, tag, ports, scope path)
   │
   ▼   ═══════════ HANDOFF to conductor ═══════════
   │   conductor points `autosploit-harness run --config` at scope.yaml
   ▼
[7 teardown] ── docker rm -f by label ; rm workdir  (ALWAYS runs)
```

Phase-A entrypoint idea: `provision <repo> --engagement-id <id> --out <dir>` ->
prints scope path + provision.json path. Conductor chains provisioner -> harness ->
teardown.

---

## 6. Tech stack

Python 3.12 — match harness (`.python-version`), same `uv` project style, **import
the frozen contract directly** (`from autosploit_harness.contracts.scope import
ScopeAllowlist` + reuse `load_scope`). Emitted YAML is language-neutral, so a later
TS control plane can shell out or reimplement — Python now costs nothing later.

| Concern | Pick | Why |
|---------|------|-----|
| Container lifecycle + inspect | `docker` SDK (docker-py) | clean port/label/inspect API |
| Build / run | docker-py `images.build` + `containers.run`, or subprocess `docker` | either; docker-py keeps it typed |
| Clone | subprocess `git --depth 1` | no GitPython dep; shallow trivial |
| Scope emit | `PyYAML` | same lib harness reads with; symmetric |
| Scope validate | reuse harness `load_scope` | single source of truth for the format |
| Typed result | `dataclass(frozen)` | match harness idiom |
| Tests | `pytest` + a tiny known image | mirror harness rig |

Phase B adds: **Kaniko** (in-cluster build), **kubernetes** python client (deploy
Pod+Service), gVisor RuntimeClass, NetworkPolicy — see `orchestration.md §8`.

---

## 7. Package layout (proposed)

Sibling of `harness/`, own `uv` project, depends on harness for the contract:
```
provisioner/
├─ pyproject.toml            # uv project; depends on autosploit-harness (path dep) for contracts
├─ src/autosploit_provisioner/
│  ├─ cloner.py              # [1]
│  ├─ resolver.py            # [2] build-ladder detection
│  ├─ booter.py              # [3] docker build + run
│  ├─ discovery.py           # [4] health + port inspect
│  ├─ scope_emit.py          # [5] write + self-validate scope.yaml
│  ├─ manifest.py            # [6] provision.json
│  ├─ teardown.py            # [7] rm by label, idempotent
│  ├─ provision.py           # orchestrates 1..6, returns ProvisionResult
│  └─ cli.py                 # `provision <repo> --engagement-id --out`
└─ tests/
   ├─ test_resolver.py       # ladder detection + reject paths
   ├─ test_scope_emit.py     # round-trips through harness load_scope
   └─ test_provision.py      # against a tiny known image (e.g. Dockerfile serving a port)
```

---

## 8. Error handling / edge cases

- **Missing Dockerfile AND compose** -> reject early, clear message, no side effects.
- **compose present** (Phase A) -> reject with "compose deferred, Dockerfile only for
  MVP" (§9), not a crash.
- **Build failure** -> surface build log tail; teardown any partial; non-zero exit.
- **Boot never healthy** (timeout) -> capture container logs to manifest; teardown; fail.
- **No published ports** -> reject: target exposes nothing to attack.
- **Emitted scope fails `load_scope`** -> abort before handoff (fail-closed, §3).
- **Teardown** must be idempotent and run on SIGINT/exception (atexit + signal), so a
  crashed provision leaves no orphaned container/workdir.
- **Token hygiene:** clone token from env only; never write it to manifest, logs, or
  the workdir; strip it from any error output.

---

## 9. Deferred / known limits

- **compose branch** — `docker-compose.yml` targets deferred. Phase A = Dockerfile
  repos only. Multi-service (app+db+cache) restores post-exploit lateral ground
  (overview §2.2) but fights the single-target scope shape; revisit in Phase B with
  per-service Services + multi-host scope (further contract bump beyond 1.1.0).
- **Buildpacks / Nixpacks** (overview §2.1 step 3) — deferred.
- **Single-host scope** — `ScopeAllowlist` is one host + ports. Fine for Phase A
  (attacker on host hits `127.0.0.1:<published>`) and Phase B single-target (Service
  DNS). Multi-service target = later additive bump.
- **Generic health check** — Phase A polls container running + port-open; does not
  wait on app-level readiness (e.g. db migrations). Good enough to prove the loop.

---

## 10. Build order (this component)

1. **Resolver + reject paths** — ladder detection; tests first (pure, no docker).
2. **Cloner** — shallow clone / local-path passthrough; token hygiene.
3. **Booter** — build + run + label against a tiny known Dockerfile.
4. **Discovery** — health poll + port inspect.
5. **Scope emitter** — write + **self-validate via harness `load_scope`** (the seam).
6. **Manifest + teardown** — provision.json; idempotent rm-by-label on all exits.
7. **provision.py + cli.py** — wire 1..6; `provision <repo> --engagement-id`.
8. **First proof** — provision Juice Shop from its Dockerfile, hand scope to harness,
   confirm `repo -> running app -> autonomous exploit -> report` with target stood up
   by the provisioner (not hand-run). Closes overview §6 step-1 vertical slice.

Then hand off to conductor (`orchestration.md §6`), then Phase B (k8s).

---

## 11. Build roadmap (detailed)

§10 is the one-line order. This section is the working plan: milestones with a
concrete goal, the files each touches, the steps, the tests, and a **gate** — the
observable condition that says the milestone is done and the next may start. Same
test-first spirit as `harness.md §9`; pure logic (resolver, scope emit) lands with
tests before anything touches Docker.

**Grounded facts (verified against the harness, do not re-derive):**
- Seam function: `load_scope(path: Path) -> ScopeAllowlist` at
  `harness/src/autosploit_harness/driver/config.py:36`. It requires a `target`
  mapping, a truthy `host`, and a non-empty `ports` list; it coerces ports with
  `int(p)`. Fail-closed: raises `FileNotFoundError` / `ValueError`.
- Contract type: `ScopeAllowlist(host: str, ports: tuple[int, ...])`, frozen +
  slots, at `harness/src/autosploit_harness/contracts/scope.py:18`.
- Path-dep target: package name is **`autosploit-harness`** (pyproject `[project].name`),
  import root `autosploit_harness`. Python pin **3.12**, `uv` project, `pytest` +
  `ruff` dev group — mirror exactly.
- Reference scope file: `harness/configs/scope.juiceshop.yaml` →
  `target: {host: 127.0.0.1, ports: [3000]}`. This is the exact byte-shape to emit.

### M0 — Scaffold the sibling project (no logic)

**Goal:** an empty, installable `provisioner/` next to `harness/` that can import the
frozen contract and run an empty test suite green.

- Create `provisioner/` as sibling of `harness/` (repo root has `docs/` + `harness/`
  today; add `provisioner/` beside them).
- `provisioner/pyproject.toml`: `name = "autosploit-provisioner"`, `requires-python
  = ">=3.12"`, deps `pyyaml`, `docker`; **path dep** on the harness for the seam:
  ```toml
  [tool.uv.sources]
  autosploit-harness = { path = "../harness", editable = true }

  [project]
  dependencies = ["pyyaml>=6.0.3", "docker>=7.1.0", "autosploit-harness"]

  [dependency-groups]
  dev = ["pytest>=9.1.1", "ruff>=0.16.2"]

  [tool.pytest.ini_options]
  pythonpath = ["src"]
  ```
- Create the package tree from §7 as empty modules (docstring only) so imports
  resolve. Add `provisioner/.python-version` = `3.12`.
- **Gate:** `uv sync` succeeds; `uv run python -c "from autosploit_harness.driver.config
  import load_scope"` works from inside `provisioner/`; `uv run pytest` collects 0
  tests and exits 0. Proves the path dep and the seam import — the one thing that
  can't be faked later.

### M1 — Resolver + reject paths (pure, no Docker)

**Goal:** decide the build branch from a directory, with every reject path exact.

- `resolver.py`: `resolve_build(workdir: Path) -> BuildPlan` where `BuildPlan` is a
  frozen dataclass `{branch: Literal["dockerfile"], dockerfile: Path}`. Detection
  only — no building.
- Branches: `Dockerfile` present → `dockerfile`. `docker-compose.yml` /
  `compose.yaml` present (and no usable Dockerfile) → raise `UnsupportedBuild`
  ("compose deferred, Dockerfile only for MVP", §9). Neither → raise
  `UnsupportedBuild` ("no Dockerfile; nothing to build").
- Typed error class `UnsupportedBuild(ProvisionError)` — one exception root so the
  CLI/conductor can catch cleanly.
- **Tests** (`test_resolver.py`, tmp_path fixtures, zero Docker): Dockerfile-only →
  plan; compose-only → reject w/ deferred message; empty dir → reject; both present
  → Dockerfile wins (documented precedence).
- **Gate:** `test_resolver.py` green; every §8 reject-string asserted verbatim.

### M2 — Cloner + token hygiene (pure-ish, no Docker)

**Goal:** turn a repo ref into a `workdir/` + commit sha, three input shapes, secret-safe.

- `cloner.py`: `resolve_source(ref: str, workdir: Path) -> Source` where `Source =
  {kind, path, commit}`. Three kinds:
  - git URL → `git clone --depth 1` (subprocess), then read `git rev-parse HEAD`.
  - local path → passthrough (no clone), commit = `git rev-parse HEAD` if it's a
    repo else `None`.
  - prebuilt image (`docker://` or bare image ref) → no clone; carry the ref for the
    booter to skip build. (Detection here; booter honors it in M3.)
- **Token hygiene (load-bearing, §8):** token read from env (`GIT_TOKEN` /
  `GITHUB_TOKEN`) only; injected into the clone URL in-memory; **never** written to
  manifest/logs/workdir. A `_redact(text)` helper strips the token from any
  subprocess stderr before it's surfaced. Test asserts the token string appears in
  no captured output.
- **Tests** (`test_cloner.py`): local-path passthrough (init a tmp git repo, assert
  commit read); redaction (inject fake token, force a clone error, assert it's
  scrubbed); image-ref detection. Real network clone stays out of unit tests (mark
  `@pytest.mark.integration`, opt-in).
- **Gate:** `test_cloner.py` green incl. redaction assertion. Token never leaves env.

### M3 — Booter (first Docker touch)

**Goal:** build + run a labeled container from a `BuildPlan`.

- `booter.py`: `boot(plan, tag, engagement_id) -> Container`. `docker build -t <tag>
  <ctx>` then `docker run -d -P --label engagement=<id> <tag>`. `-P` auto-publishes
  every `EXPOSE`d port. Image-ref source → skip build, just run.
- Use docker-py (`docker.from_env()`); `images.build` + `containers.run`. On build
  failure, capture the **log tail** into the raised error (§8) and ensure no partial
  container is left (teardown hook from M5 covers crash paths; here just don't leak
  the half-built run).
- **Test fixture:** a tiny in-repo Dockerfile under `tests/fixtures/` that serves a
  port (e.g. `FROM python:3.12-slim` + `EXPOSE 8000` + `python -m http.server`).
  This is the "tiny known image" the whole rig leans on — cheap, deterministic.
- **Tests** (`test_booter.py`, `@pytest.mark.integration`, needs a Docker daemon):
  build fixture → container id + `engagement` label present; build a deliberately
  broken Dockerfile → `BuildFailed` with log tail, no orphan container.
- **Gate:** fixture container boots under a Docker daemon; label queryable via
  `docker ps -f label=engagement=<id>`.

### M4 — Discovery (health + port inspect)

**Goal:** know the target is up and which host ports to hand over.

- `discovery.py`: `discover(container, timeout_s, backoff) -> Ports`. Poll container
  state to `running` (respect a healthcheck if the image declares one; else
  running + at least one published port bound = ready). Read published ports from
  `container.attrs["NetworkSettings"]["Ports"]` — map each `"<cport>/tcp"` to its
  host binding, collect the distinct **host** ports.
- Reject if the container exits or no port is published (§8: "target exposes nothing
  to attack"). On timeout, pull `container.logs()` tail for the manifest, then fail.
- Phase-A limit (§9): running + port-open only, no app-level readiness. Good enough
  to prove the loop.
- **Tests** (`test_discovery.py`, integration on the M3 fixture): fixture → discovers
  the published host port; a `EXPOSE`-less image → reject; a container that exits
  immediately → timeout/exit reject with captured logs.
- **Gate:** discovery returns the fixture's host port; both reject paths fire.

### M5 — Scope emitter + manifest + teardown (the seam + safety)

**Goal:** write the frozen scope, self-validate it through the harness, record the
run, and guarantee cleanup.

- `scope_emit.py`: `emit_scope(host, ports, out) -> Path`. Write exactly
  `target: {host: "127.0.0.1", ports: [<int>...]}` via PyYAML. **Then self-validate:
  call `load_scope(out)` and confirm the returned `ScopeAllowlist.ports` equals what
  was passed.** If it raises or mismatches → abort before handoff (fail-closed, §3).
  This is the single most important assertion in the component: the harness's own
  parser is the acceptance test for the file.
- `manifest.py`: `write_manifest(...) -> Path` → `provision.json`: engagement id,
  repo ref + commit sha, build branch, image tag, container id(s), published ports,
  scope path, ISO timestamps. **No token, ever** (§8).
- `teardown.py`: `teardown(engagement_id, workdir)` → `docker rm -f` all containers
  matching `label=engagement=<id>`, remove workdir. Idempotent (second call is a
  no-op, not an error). Registered on `atexit` + `SIGINT`/`SIGTERM` so a crashed
  provision leaves no orphan container/workdir.
- **Tests:** `test_scope_emit.py` (pure) — round-trip a written scope through the
  real `load_scope`, assert `ScopeAllowlist(host, ports)` matches; assert an
  empty-ports emit is rejected. `test_teardown.py` (integration) — boot fixture,
  tear down, assert `docker ps -a` shows nothing for the label; call teardown twice,
  assert idempotent.
- **Gate:** scope written by the emitter parses through the harness's `load_scope`
  with equal ports; teardown-by-label leaves zero residue and is idempotent.

### M6 — Orchestrator + CLI (wire 1..7)

**Goal:** one entrypoint runs the whole chain and always cleans up.

- `provision.py`: `provision(ref, engagement_id, out_dir) -> ProvisionResult`
  (frozen: scope_path, manifest_path, ports, container_ids). Sequence cloner →
  resolver → booter → discovery → emitter → manifest, with teardown wrapping the
  whole thing in try/finally so any failure still tears down.
- `cli.py`: `provision <repo> --engagement-id <id> --out <dir>`; on success prints
  the scope path + provision.json path (machine-parseable, for the conductor to
  chain). Non-zero exit on any reject/failure with the §8 message.
- Register `provision` as a `[project.scripts]` entry.
- **Tests** (`test_provision.py`, integration on fixture): full run → scope + manifest
  on disk, scope parses via `load_scope`, container up; then teardown clean. Failure
  injection (broken Dockerfile) → non-zero exit, no orphan.
- **Gate:** `uv run provision tests/fixtures/<dir> --engagement-id t1 --out /tmp/e`
  emits a harness-valid scope and tears down clean.

### M7 — First real proof (closes overview §6 step-1 vertical slice)

**Goal:** provisioner stands up Juice Shop from *its* Dockerfile and the harness
exploits it — no hand-run target.

- Point the provisioner at a Juice Shop checkout (has a `Dockerfile`). It emits a
  scope equivalent to today's hand-written `harness/configs/scope.juiceshop.yaml`
  (`127.0.0.1` + the published 3000-host-port), but **produced by the provisioner**.
- Feed that scope to `autosploit-harness run --config <run.toml pointing at it>`.
  Confirm the full loop: `repo → running app → autonomous exploit → report`.
- Teardown removes the Juice Shop container after.
- **Gate:** end-to-end run where the target was provisioned, not hand-started.
  This is the deploy half of the overview §6 step-1 slice; the attack half already
  passes on the hand-written scope.

### Milestone → gate summary

| M | Deliverable | Gate (done when…) | Docker needed |
|---|-------------|-------------------|:---:|
| M0 | scaffold + path dep | `load_scope` imports from inside `provisioner/`; `pytest` green on 0 tests | no |
| M1 | resolver | every §8 reject string asserted; Dockerfile branch chosen | no |
| M2 | cloner | 3 source kinds; token provably never leaves env | no* |
| M3 | booter | fixture container boots, labeled | yes |
| M4 | discovery | host port discovered; both reject paths fire | yes |
| M5 | emitter+manifest+teardown | emitted scope parses via harness `load_scope`; teardown idempotent, zero residue | partial |
| M6 | orchestrator+CLI | one command emits valid scope + tears down on success & failure | yes |
| M7 | real proof | provisioner-stood-up Juice Shop exploited end-to-end | yes |

\* M2 network clone is opt-in integration only; unit tests stay Docker/network-free.

**Ordering rule:** M0–M2 are pure and land first (fast, deterministic, no daemon).
M3+ require a Docker daemon and use the one tiny in-repo fixture image; gate them
behind `@pytest.mark.integration` so the pure suite stays runnable anywhere. The
seam self-validation (M5) is the component's contract with the harness — treat its
test as non-negotiable.
