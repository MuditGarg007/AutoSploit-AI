# M5 — phased execution plan

Companion to the approved M5 plan (`lets-do-m5-now-parallel-bentley.md`). Same design
and decisions; this splits the work into phases that each land, commit, and verify
independently, keeping the test suite green at every commit.

M5 has two scoped roles (both in scope):

1. **Harness image + CI to GHCR** — the roadmap's literal M5 exit gate
   (`isolation-hardening-roadmap.md:86-96`): build/scan/push the attacker **harness**
   image and have the cluster pull it **by digest**. Today `release.yml` builds only the
   control-plane image and the conductor launches the attacker from a placeholder
   (`k8s/run.py:71`).
2. **In-cluster repo/base mirror** ("the M5 registry path",
   `deferred-open-items.md:107-117`, roadmap M8 "Open" `:206-211`): under the live M7
   default-deny egress the Kaniko build Pod can reach no external git host or base-image
   registry, so external `git clone` and `FROM <external>` base pulls are denied. M5
   closes this with an **intra-namespace mirror** — the conductor (which has egress)
   clones the repo and preloads base images into the per-engagement registry; Kaniko
   builds from a `dir://` ConfigMap context and pulls bases via `--registry-mirror`. No
   egress-matrix widening.

## Decisions (approved)

- **Base-image resolution:** Kaniko `--registry-mirror` (not Dockerfile FROM-rewrite).
  Requires pinning `KANIKO_IMAGE` by digest, since mirror-flag behavior is
  version-sensitive.
- **Conductor image:** add a hardened `conductor/Dockerfile` (git + crane baked in).
- **Digest-ref injection:** env var `AUTOSPLOIT_HARNESS_IMAGE` carrying
  `ghcr.io/<owner>/harness@sha256:…`, symmetric with the existing
  `AUTOSPLOIT_ENGAGEMENT_CHART` seam.
- **Proof:** in-cluster registry on air-gapped kind now; the real GHCR digest-pull rides
  H3 (same deferral as M7's internet edges).

Guiding rule (mirrors M9): **no commit both adds a new path and deletes the old one.**
The provision behavior switch (Phase 5) replaces the denied `git://` external context
with the mirror path; the old `_kaniko_context` git-prefix branch is removed in the same
phase only because it is provably dead once the switch lands (its output was always
denied under the live policy).

Layering invariant throughout: `manifests` = pure builders · `client` = k8s API via
injected seam · `provision`/`run` = sequencing · `factory` = only module importing
`kubernetes`. Everything **fail-closed**: a clone/mirror/oversize failure raises
`ProvisionError`, recorded as `failed(provision)`.

The two roles are independent — Phases 1–3 (Role 1) and Phases 4–6 (Role 2) can proceed
in either order; Phase 7 proves both; Phase 8 closes the docs.

---

## Phase 1 — Harness image (Role 1, additive)

**Goal:** the harness builds into a hardened, secret-free container image locally.

**Changes**
- `harness/Dockerfile` (new) — mirror the hardening of `control-plane/Dockerfile:1-43`
  for the Python/uv/hatchling stack: multi-stage `python:3.12-slim`, `uv sync --frozen
  --no-dev`, non-root user (`groupadd -r … && useradd -r -g … -m`, `USER autosploit`),
  `ENTRYPOINT ["autosploit-harness"]`,
  `CMD ["run","--config","/etc/autosploit/run.toml"]` (matches the chart mount,
  `deploy/helm/engagement/values.yaml:50-51`). No secrets baked; header comment states
  `OPENROUTER_API_KEY` never enters the image.
- `harness/.dockerignore` (new) — exclude `.env`, `.venv`, `.pytest_cache`, tests.

**Verify**
- `docker build -t harness:proof ./harness`
- `docker run --rm harness:proof --help` → prints the CLI usage (exit 0).
- Leak check: `docker run --rm --entrypoint sh harness:proof -c 'grep -rIsE "sk-or-[A-Za-z0-9-]{8,}" / | grep -v "^Binary" || true'` → empty. (The harness ships Python **source**, so the env-var *name* `OPENROUTER_API_KEY` legitimately appears in `gateway/client.py`; the scan targets the key **value** shape `sk-or-…`, the actual secret — unlike the control-plane image, which is compiled dist where the name does not surface.)

**Commit:** `M5: harden the harness image (Dockerfile + dockerignore)`

---

## Phase 2 — CI: harness build → scan → push → digest (Role 1, additive)

**Goal:** the release workflow builds, scans, and pushes the harness image and emits its
digest, exactly mirroring the control-plane `build-push` job.

**Changes**
- `.github/workflows/release.yml` — add `HARNESS_IMAGE` to `env:`; add a
  `harness-build-push` job mirroring `build-push` (`:27-61`): login → build → Trivy
  HIGH/CRITICAL → leak scan (value shape `sk-or-…`, see Phase 1) → push. A `push` step captures the pushed digest into
  `$GITHUB_OUTPUT`; declare `outputs.digest`.
- Wire `deploy-gke` (`:79-105`) to `needs` the new job and set the conductor Deployment
  env `AUTOSPLOIT_HARNESS_IMAGE` to the digest output.

**Verify**
- `actionlint .github/workflows/release.yml` (or GitHub's workflow linter) — no errors.
- Structural review against the existing `build-push` job: same scan/leak gates present.
  (Full run is a CI concern; no local cluster step.)

**Commit:** `M5: build, scan, and push the harness image to GHCR (digest output)`

---

## Phase 3 — Digest injection seam (Role 1, behavior)

**Goal:** the conductor launches the attacker from a digest-pinned ref supplied by the
environment, defaulting to the obvious placeholder when unset.

**Changes**
- `conductor/src/autosploit_conductor/cli.py` (`_run_k8s`) — read
  `os.environ.get("AUTOSPLOIT_HARNESS_IMAGE")`; if set, pass into
  `run_k8s(attacker_image=…)`. The value already flows `run_k8s` → `_chart_values`
  (`run.py:236,254`) → chart `attacker.image`.
- Update the `_DEFAULT_ATTACKER_IMAGE` comment (`run.py:68-71`) to point at the override.
- Tests: `conductor/tests/test_k8s_factory_cli.py` —
  `test_cli_k8s_reads_harness_image_env`, `test_cli_k8s_defaults_harness_image`;
  `conductor/tests/test_k8s_run.py` — `test_attacker_image_flows_to_chart_values`.

**Verify:** `cd conductor && uv run pytest tests/test_k8s_factory_cli.py tests/test_k8s_run.py`

**Commit:** `M5: inject the digest-pinned harness image via AUTOSPLOIT_HARNESS_IMAGE`

---

## Phase 4 — Mirror builders + seam (Role 2, additive, no callers)

**Goal:** the pure builders and the client seam for the mirror path exist and are
covered. Nothing calls them yet.

**Changes**
- `conductor/src/autosploit_conductor/k8s/manifests.py`
  - `build_context_configmap_manifest(engagement_id, files, name="build-context")` —
    namespaced, engagement-labelled ConfigMap (mirror `secret_manifest:180-197`).
  - Extend `kaniko_build_pod_manifest` (`:248`) with `registry_mirror: str | None`;
    when set append `--registry-mirror=<mirror>`, `--insecure-pull`,
    `--skip-default-registry-fallback` (keep push-side `--insecure`). Update the
    "external clone/FROM denied" docstring note (`:265-270`).
  - Constants near the M8 block: `BUILD_CONTEXT_CONFIGMAP`; `registry_mirror_endpoint()`
    (reuse `registry_endpoint:152-157`). **Pin `KANIKO_IMAGE` by digest** (`:72`).
- `conductor/src/autosploit_conductor/k8s/client.py`
  - Add `create_namespaced_config_map` to the `CoreV1` Protocol (`:53-67`).
  - `EngagementCluster.create_build_context_configmap(files)` (mirror `apply_secret`).
  - Forward `registry_mirror` through `create_build_pod` (`:167-197`).
- Tests: `test_k8s_manifests.py` — `test_build_context_configmap_shape`,
  `test_kaniko_pod_has_registry_mirror_args`; keep the "no docker socket / hostPath /
  not privileged" asserts green. `test_k8s_client.py` —
  `test_create_build_context_configmap_calls_api`, `test_build_pod_forwards_registry_mirror`.

**Verify:** `cd conductor && uv run pytest tests/test_k8s_manifests.py tests/test_k8s_client.py`

**Commit:** `M5: mirror builders — build-context ConfigMap + Kaniko registry-mirror args`

---

## Phase 5 — Provision switches to the mirror path (Role 2, behavior)

**Goal:** `phaseb_provision` clones the repo conductor-side, preloads base images into
the per-engagement registry, feeds Kaniko a `dir://` ConfigMap context, and builds via
the registry mirror. The denied `git://` external-context branch is removed.

**Changes**
- `conductor/src/autosploit_conductor/k8s/mirror.py` (new) — a crane-copy helper
  (`mirror_base_image(src, dst)`, plain-http dest, no docker socket), the only new module
  that shells out; injectable.
- `conductor/src/autosploit_conductor/k8s/provision.py` (`phaseb_provision`, `:44-105`):
  after the registry is Ready, before `create_build_pod` — (1) clone via reused
  `autosploit_provisioner.source.cloner.resolve_source`; (2) parse `FROM` lines and
  `mirror_fn` each external base into `registry.<ns>.svc:5000`; (3) pack the workdir and
  `create_build_context_configmap` (enforce the ConfigMap **1 MiB** ceiling →
  `ProvisionError` on oversize, message pointing at the deferred git-mirror-Pod path).
  Replace `_kaniko_context` (`:108-116`) with a `dir://` context + `context_configmap` +
  `registry_mirror`; keep passthrough for refs already carrying a scheme.
- Tests: `test_k8s_provision.py` — extend `FakeCluster` with
  `create_build_context_configmap` and a recorded `mirror_fn`; assert flow = registry →
  clone → mirror base → context ConfigMap → build with `dir://` + mirror args (no
  `git://`); add `test_oversize_context_fails_closed`, `test_mirror_failure_fails_closed`.

**Verify:** `cd conductor && uv run pytest tests/test_k8s_provision.py tests/test_k8s_run.py`

**Commit:** `M5: provision builds real repos via the in-cluster repo/base mirror`

---

## Phase 6 — Conductor image (Role 2, additive)

**Goal:** the conductor runs in a hardened image carrying `git` and `crane`.

**Changes**
- `conductor/Dockerfile` (new) — multi-stage, non-root where possible, no secrets baked;
  `git` and `crane` present at runtime.

**Verify**
- `docker build -t conductor:proof ./conductor`
- `docker run --rm conductor:proof git --version && docker run --rm --entrypoint crane conductor:proof version`

**Commit:** `M5: hardened conductor image with git + crane for the mirror path`

---

## Phase 7 — Live proof on kind (both roles)

**Goal:** prove digest-pull of the harness image and a mirror build under the **live** M7
policy, on the air-gapped kind cluster.

**Changes**
- `scripts/m5-proof.sh` (new) — mirror `m8-proof.sh`/`m9-proof.sh` conventions
  (`render()`/`apply()` over the conductor's own builders, `trap cleanup EXIT`, kind
  context `kind-autosploit-hardening`). Note: `m8-proof.sh` is **stale post-M9** (renders
  the removed `target_pod_manifest`) — route around it; deploy any target from the Helm
  chart, not `manifests`.

**Part A — digest-pull (Role 1)**
- Namespace + registry up → `docker build ./harness` → push into the in-cluster registry,
  capture the digest → deploy an attacker Pod **by digest** from the chart
  (`helm … --set attacker.image=<…@sha256> --set attacker.command='{autosploit-harness}'
  --set attacker.args='{--help}'`, no model key).
- **Assert:** the Pod pulls by digest and the harness binary runs (exit 0). GHCR
  digest-pull rides H3.

**Part B — mirror build under the live policy (Role 2)**
- Namespace + registry, then **apply `network_policy_manifest`** (live default-deny
  egress). `crane copy busybox:1.36` into the registry (the conductor-side egress step).
  Build-context ConfigMap from an external-style repo whose Dockerfile is
  `FROM busybox:1.36`. Run the Kaniko Pod with `dir://` context + `registry_mirror`.
- **Assert:** the build **Succeeds** under the live policy. Causation control: a sibling
  build Pod with a raw `git://github.com/…` external context **fails** its clone under
  the same policy — proving egress is still closed and the mirror, not a policy hole,
  closed the gap.

**Verify:** `./scripts/m5-proof.sh` exits 0 with both parts' assertions green.

**Commit:** `M5: live proof — harness digest-pull + mirror build under live egress`

---

## Phase 8 — Docs close-out

**Goal:** the roadmap and open-items reflect M5 as done.

**Changes**
- `docs/isolation-hardening-roadmap.md` — mark M5 DONE with the proof reference; update
  the M8 "Open (egress ingestion, → M5)" note (`:206-211`) to closed.
- `docs/deferred-open-items.md:107-117` — close the build-context-ingestion item.
- Update the memory pointer (`m5-*.md`) if kept.

**Verify:** links resolve; no dangling "→ M5" references remain.

**Commit:** `docs: M5 done — harness image + in-cluster repo/base mirror`

---

## Risks / notes

- **Kaniko mirror flags are version-sensitive** — pin `KANIKO_IMAGE` by digest; fallback
  if a version misbehaves is FROM-rewrite (not chosen now).
- **ConfigMap 1 MiB ceiling** is the accepted MVP repo-size limit (fail-closed on
  oversize); the git-mirror Pod is the deferred scale path.
- M5 does not touch `CONTRACT_VERSION` (stays `1.0.0`; the `1.1.0` bump is
  provisioner-side, M6a). New tests that round-trip the conductor scope through
  `load_scope` must stay green under `1.0.0`.
- The preload works because the M7 policy is **egress-only**. If an ingress rule is ever
  added to `network_policy_manifest`, the preload path breaks — noted in code.
