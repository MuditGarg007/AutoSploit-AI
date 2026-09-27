# M9 — phased execution plan

Companion to `help-me-complete-m9-indexed-breeze.md` (the approved M9 plan). Same
design and decisions; this splits the work into six phases that each land, commit, and
verify independently. The ordering keeps the test suite green at every commit: the
chart and the helm seam are added *before* anything switches to them, and the dead
Python builders are removed *after* the switch, never during.

Guiding rule: **no commit both adds the new path and deletes the old one.** The
behavior switch (Phase 3) leaves the old builders in place but unused; Phase 4 deletes
them as a pure no-op cleanup.

---

## Phase 1 — Author the engagement chart (additive, no Python touched)

**Goal:** the `deploy/helm/engagement/` chart exists and renders correct objects. No
conductor code depends on it yet.

**Changes**
- `deploy/helm/engagement/Chart.yaml`, `values.yaml`, `templates/_helpers.tpl`,
  `templates/{target-pod,target-service,attacker-pod,run-config}.yaml`.
- Fixed resource names (no `{{ .Release.Name }}-` prefix) — `target`, `attacker`,
  `run-config` are contractual (target Service DNS = scope host, M6a).
- New `conductor/tests/test_engagement_chart.py` — renders the chart (`helm template`)
  and asserts the security invariants; skips if `helm` is not on PATH.

**Verify**
- `helm lint deploy/helm/engagement`
- `helm template eng deploy/helm/engagement -n engagement-x --set engagementId=x \
   --set target.image=nginx --set target.port=80 --set attacker.image=curlimages/curl`
  → eyeball: both Pods carry `runtimeClassName: gvisor` + `restartPolicy: Never`;
  attacker key is a `secretKeyRef` (name `model-key`), never an inlined value; Service
  selector is `role=target`; names are unprefixed.
- `cd conductor && uv run pytest tests/test_engagement_chart.py`

**Done when:** chart lints, renders, and the render test passes. Everything else in the
repo is untouched, so the full suite is exactly as green as before.

**Commit:** `M9: add the per-engagement Helm chart (chart + render test)`

---

## Phase 2 — Add the helm runner seam (additive, no callers)

**Goal:** a testable `helm install`/`helm uninstall` wrapper exists, isolated like
`k8s/factory.py`. Nothing calls it yet.

**Changes**
- `conductor/src/autosploit_conductor/k8s/helm.py` — `install_release(...)` /
  `uninstall_release(...)`, with the `subprocess.run` callable injectable. Non-zero exit
  → `ConductorError`.
- New `conductor/tests/test_k8s_helm.py` — inject a fake `run`, assert the argv and the
  temp values file; assert the raise path on non-zero exit. No helm binary or cluster
  needed.

**Verify:** `cd conductor && uv run pytest tests/test_k8s_helm.py`

**Done when:** the seam is covered and unused; suite green.

**Commit:** `M9: add injectable helm-release runner (k8s/helm.py)`

---

## Phase 3 — Switch the orchestrator to install the chart (behavior change)

**Goal:** `run_k8s` stands the engagement workload up via a real Helm release and tears
it down with `helm uninstall` + namespace delete. This is the milestone's exit criterion
made live. The old builders remain present but stop being called.

**Changes**
- `k8s/run.py`: `run_k8s` gains injected `helm` + `chart_dir` params (default: real
  runner + resolved chart path). `_run_engagement` replaces the four imperative calls
  (`create_target_pod`, `create_target_service`, `apply_configmap`,
  `create_attacker_pod`) with `cluster.apply_secret(api_key)` +
  `helm.install_release(...)` (values from `prov` + attacker image/command/args +
  `secretName`). `watch_pod`/`_collect_logs` unchanged. `_teardown` gains a best-effort
  `helm.uninstall_release(...)` before `delete_namespace()`.
- `cli.py`: `_run_k8s` injects the real helm runner + chart dir (module default
  `deploy/helm/engagement`, env override `AUTOSPLOIT_ENGAGEMENT_CHART`).
- `conductor/tests/test_k8s_run.py`: reworked to inject a fake helm runner — assert
  install called with the right release/namespace/values, attacker watched via the fake
  cluster, and uninstall + namespace delete on every terminal path (success, provision
  failure, timeout, exception).

**Verify:** `cd conductor && uv run pytest tests/test_k8s_run.py tests/test_k8s_cli.py`
(plus the Phases 1–2 tests still green).

**Done when:** the conductor drives the chart end to end in unit tests; the four old
builder methods are now dead code but still defined (suite green because their own tests
still pass).

**Commit:** `M9: conductor installs the engagement chart as a Helm release`

---

## Phase 4 — Remove the superseded builders (pure cleanup)

**Goal:** delete the now-dead Python that the chart replaced. No behavior change.

**Changes**
- `k8s/manifests.py`: remove `target_pod_manifest`, `target_service_manifest`,
  `attacker_pod_manifest`, `configmap_manifest` + constants only they used. Keep
  namespace/secret/netpol/registry/Kaniko builders and all name/DNS helpers still used
  by Python (`namespace_name`, `engagement_labels`, `target_service_dns`,
  `target_image_ref`, `registry_endpoint`).
- `k8s/client.py`: remove `create_target_pod`, `create_target_service`,
  `apply_configmap`, `create_attacker_pod` and the `CoreV1` Protocol methods no longer
  used. Keep namespace/netpol/secret/registry/build + the reads the watcher needs.
- `test_k8s_manifests.py` / `test_k8s_client.py`: drop the cases for the removed
  symbols.

**Verify:** `cd conductor && uv run pytest` — full k8s suite green; grep confirms no
remaining references to the removed names.

**Done when:** dead code gone, suite green.

**Commit:** `M9: drop the manifest/client builders the chart supersedes`

---

## Phase 5 — Live proof on kind

**Goal:** demonstrate the real thing on the M4 kind cluster.

**Changes**
- `scripts/m9-proof.sh` (mirror `scripts/m8-proof.sh`): namespace + netpol imperative,
  `helm install` the chart with stand-in images (nginx target, curl attacker), show
  attacker→target reachable and egress enforced, then `helm uninstall` + namespace
  delete and show it gone.

**Verify**
- `scripts/m4-bootstrap.sh` (if no cluster), then `scripts/m9-proof.sh m9proof` → green.
- End-to-end: `conductor run <dockerfile-repo> --k8s --target-port <p>` against kind —
  target built (M8), egress locked (M7), workload installed as a Helm release (M9),
  `conductor.json` written, release + namespace gone on exit.

**Done when:** the proof script passes on kind.

**Commit:** `M9: live proof of the engagement chart on kind (scripts/m9-proof.sh)`

---

## Phase 6 — Docs + memory

**Goal:** record M9 as done and note the deviation.

**Changes**
- `docs/isolation-hardening-roadmap.md`: M9 → done with a status line; update the header
  Done/Open lists; record the namespace/netpol-imperative deviation and its rationale.
- `docs/orchestration.md`: update if it documents the Phase-B apply flow.
- `CLAUDE.md` / auto-memory: a short M9-done note beside the `m6-conductor-k8s-done`
  neighbours, incl. the chart location and the imperative-scaffold split.

**Verify:** docs read correctly; roadmap header matches reality.

**Commit:** `docs: M9 done — engagement Helm chart (with the scaffold-split note)`

---

## Sequencing summary

| Phase | Adds | Removes | Suite green because |
|------|------|---------|---------------------|
| 1 | chart + render test | — | purely additive |
| 2 | helm seam + test | — | purely additive, unused |
| 3 | chart-install wiring | (old path unused) | old builders still defined + tested |
| 4 | — | dead builders + their tests | nothing calls them anymore |
| 5 | proof script | — | additive; live verification |
| 6 | docs/memory | — | no code |

Natural stopping points after any phase. Phases 1–2 can even land ahead of a decision to
flip Phase 3, since they change no behavior.
