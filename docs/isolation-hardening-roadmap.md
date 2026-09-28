# Isolation Hardening — Roadmap (Step 3)

> **Status: in progress (updated 2026-09-28).** Done: M4, M5, M6, M7, M8, M9. M7
> enforcement proven live on kind (its two internet-dependent SEAM-1 assertions ride
> the H3 online run); M8 Kaniko in-cluster build proven live on kind; M5 closed its
> external clone/base ingestion — the conductor now clones repo-side and mirrors bases
> into the per-engagement registry, proven live under real egress (`scripts/m5-proof.sh`),
> which also unstubs the M8 provision seam (`k8s/provision.py` is now real, not the M6
> placeholder); M9 engagement Helm chart proven live on kind (`scripts/m9-proof.sh`),
> with the namespace/netpol/secret kept imperative and fail-closed ahead of the release
> — see the M9 section.
> Open: H3 (M6a is now DONE — `CONTRACT_VERSION` bumped to 1.1.0). Execution roadmap
> for build-order step 3
> (`overview.md §6`): move engagement execution off plain local Docker onto a
> hardened Kubernetes substrate so untrusted user repos run safely isolated. This is
> **provisioner + conductor Phase B** (`orchestration.md §9`). It is a tracking and
> sequencing doc — the linked design docs remain the authority for *why* each piece
> is shaped the way it is; this doc says *what to build, in what order, and how we
> know each step is done*.

---

## 1. Goal

Turn the two load-bearing security invariants from "true by construction" into
"enforced by the runtime, and proven under a red-team pass":

1. **Egress matrix.** The sandbox pushes out on exactly one set of edges —
   attacker → target, attacker → model API, attacker → control plane — and nothing
   else. Enforced by Cilium `NetworkPolicy` (`orchestration.md §4.1`).
2. **Secret split.** The GitHub token stays provisioner-side (clone only, never
   logged, never to the harness); `OPENROUTER_API_KEY` stays conductor/harness-side
   and never enters the provisioner. Enforced by the component/trust-boundary split
   (`orchestration.md §2`).

The exit condition for the whole step is `scripts/redteam.sh` running **green on a
real GKE deploy** against the real NetworkPolicy (the H3 exit gate).

---

## 2. Where we start (baseline, 2026-09-15)

**Already built and waiting on a cluster** (verified against the tree):

- `deploy/terraform/main.tf` — GKE Autopilot + Vault + registry.
- `deploy/helm/control-plane/` — Helm chart, **control plane only** (no engagement
  resources yet).
- `scripts/redteam.sh` — the §7 red-team pass (SEAM-1 egress matrix, SEAM-2 secret
  split).
- `control-plane/test/hardening.spec.ts` — the seam proofs that run in CI.
- `.github/workflows/release.yml` — build → scan → push → GHCR, `redteam-kind`
  reduced pass per push/tag, `deploy-gke` behind a `production` approval
  environment, then the full GKE red-team pass as the release gate.

**Settled decisions** (see `deferred-open-items.md`):

- Isolation provider = **self-hosted K8s + gVisor** (managed microVM rejected).
- Red-team cadence = full GKE §7 pass is the **release gate**; the kind pass plus
  `hardening.spec.ts` is the per-merge continuous guard.

**The gap.** The provisioner and conductor are **Phase A only — plain local
Docker** (`docker build` + `run -P`, harness run as a local subprocess). A code
grep finds no gVisor / Kaniko / `RuntimeClass` / `NetworkPolicy` anywhere but doc
comments. Closing this gap *is* the roadmap below.

---

## 3. Milestones

Sequenced from `orchestration.md §9 Phase B`. Each milestone lists its work, its
exit criterion (how we know it's done), and what it depends on. Numbering continues
the §9 Phase B build order (steps 4–9) so the two docs line up.

### M4 — Local cluster substrate — DONE 2026-09-23

- **Work:** stand up a local **k3s / kind** cluster with the **Cilium** CNI, via
  Terraform or a scripted bootstrap. Install the **gVisor** `RuntimeClass`. Get a
  bare Pod scheduling under the gVisor runtime.
- **Exit:** `kubectl` can create a namespace and schedule a gVisor Pod that runs; a
  trivial NetworkPolicy denies traffic as expected.
- **Depends on:** nothing. **Start here** — cheapest loop, everything stacks on it.
- **Status — DONE.** Shipped in commit `d42141f` (M4 substrate): scripted bootstrap
  `scripts/m4-bootstrap.sh` plus `deploy/kind/`, `deploy/helm/`, `deploy/terraform/`.
  kind + Cilium CNI + gVisor `RuntimeClass` stand up; a gVisor Pod schedules and a
  trivial NetworkPolicy bites. Independently re-proven live by M6's
  `tests/integration/test_m6_live.py`, which runs gVisor target + attacker Pods on
  this same kind cluster end to end. (Substrate note: on this kernel kind needs
  Cilium >= 1.21.0-pre.2 — see the M4 bootstrap.)

### M5 — Harness image + in-cluster repo/base mirror — DONE (live on kind 2026-09-28)

- **Work:** the harness (attacker) image is built and digest-pinned into the
  engagement (`AUTOSPLOIT_HARNESS_IMAGE`, commit `d123fc0`), and — the part that
  grew past the original scope — the **in-cluster repo/base mirror** that lets a
  Kaniko build run under the M7 default-deny egress: the conductor (which *does*
  have egress) clones the user repo conductor-side and preloads each external `FROM`
  base into the per-engagement registry, so the air-gapped build Pod reaches neither
  an external git host nor a base-image registry.
- **Exit:** a real repo builds through the mirror path under live egress — harness
  pulled by digest, bases mirrored, Kaniko builds and pushes, target runs.
- **Depends on:** M4, M6, M8 (registry path).
- **Status — DONE.** Built as `conductor/src/autosploit_conductor/k8s/mirror.py`
  (base preload + Kaniko `--registry-mirror` args) and a rewritten `k8s/provision.py`
  that now does the real clone → mirror → `dir://` build-context ConfigMap → Kaniko
  build → deploy — this **unstubs the M6/M8 provision seam** (it was a
  `failed(provision)` placeholder). The conductor image is hardened with `git` +
  `crane` for the mirror path (`conductor/Dockerfile`, commit `fab666c`). **Proven
  live** by `scripts/m5-proof.sh` (2026-09-28, commit `be4aad3`): harness digest-pull
  + mirror build under real egress. This closes the M8 "external clone/base
  ingestion" open item.

### M6 — Conductor as a Kubernetes controller — DONE 2026-09-24

- **Work:** replace the Phase-A subprocess conductor with a real Python
  `kubernetes` client. Per engagement: create `engagement-<id>` namespace, launch
  attacker + target Pods under the gVisor `RuntimeClass`, expose the target via a
  **Service**, watch to completion, and tear down by **deleting the namespace**
  (idempotent; runs on success, failure, and interruption).
- **Exit:** an engagement runs entirely on the cluster — namespace created, attacker
  reaches the target over the Service DNS, report collected, namespace deleted with
  nothing left behind.
- **Depends on:** M4, M5.
- **Status — DONE.** Built as `conductor/src/autosploit_conductor/k8s/`
  (`manifests` → `client` → `watch` → `run` → `factory`/`provision`), all layers
  test-first (46 unit tests, `kubernetes` import isolated to the one `factory`).
  CLI wired: `conductor run <repo> --k8s`. **Exit criterion proven on the live M4
  kind cluster** by `tests/integration/test_m6_live.py`: it drives the real
  `EngagementCluster` + `watch_pod` end to end — namespace → gVisor target
  (nginx) + Service → gVisor attacker (curl) reaching the target over its Service
  DNS → report (logs) collected → namespace deleted → verified zero residue.
  Stand-in images (nginx/curl) are legitimate placeholders for what the *other*
  milestones supply — the real harness image is **M5**, the in-cluster Kaniko
  target build is **M8** — so what is closed here is exactly M6's own scope: the
  conductor's controller loop on real infra. (Historical note: M6 shipped the
  provision seam `k8s/provision.py` as a `failed(provision)` placeholder; it was made
  real by M8 and completed by M5 — it now clones, mirrors, Kaniko-builds, and deploys.)

### M6a — Scope contract bump to 1.1.0 — DONE 2026-09-28

- **Work:** the scope `host` field carries the target **Service DNS name** instead of
  `127.0.0.1`. Same shape, wider value domain — an additive **MINOR** change
  (`orchestration.md §4.1`). Bump `CONTRACT_VERSION` to `1.1.0` when the provisioner
  starts emitting Service DNS; the emit slice must still self-validate through the
  harness `load_scope`.
- **Exit:** provisioner emits a Service-DNS scope that round-trips through
  `load_scope`; harness attacks the target over cluster DNS, not loopback.
- **Depends on:** M6 (rides with the conductor/provisioner cutover).
- **Status — DONE 2026-09-28.** The data-plane landed with M5; the deliberate
  `CONTRACT_VERSION` `1.0.0` → `1.1.0` MINOR bump (the "now emitting Service DNS"
  signal) is now made (`harness/contracts/version.py:18`) and the golden contract
  descriptor regenerated via `autosploit-harness contract`
  (`harness/contracts/contract.schema.json`, now `1.1.0`). The regen also
  normalized the committed golden from CRLF to the generator's LF, which had left
  the drift guard `test_committed_contract_matches_live_shapes` red on a clean
  Linux checkout; the full contract suite (15) and harness suite (65) are now green.
  The emit moved into the conductor's in-cluster Phase-B provisioner
  (`k8s/provision.py`), not the old `autosploit_provisioner` — `_emit_config` now
  writes `scope.yaml` with `host: target_service_dns(<id>)` (provision.py:130, 299),
  the Service DNS, not `127.0.0.1`. That payload **round-trips through the harness
  `load_scope`** unchanged: `load_scope` parses `target:{host,ports}`
  (`harness/driver/config.py:36`), which is exactly the emitted shape (the scope
  format is a frozen seam, so only the value domain widened). So the exit criterion —
  Service-DNS scope round-trips, harness attacks over cluster DNS not loopback — is
  met, and the `CONTRACT_VERSION` bump (`harness/contracts/version.py:18` → `1.1.0`)
  that signals "now emitting Service DNS" has been made and the golden regenerated —
  so this milestone is DONE.

### M7 — NetworkPolicy: the egress matrix, enforced — enforcement proven live; external edges ride H3

- **Work:** apply a **default-deny egress** NetworkPolicy in the engagement
  namespace, allowing exactly attacker → target, attacker → model API (FQDN / CIDR),
  and attacker → control plane. This is the `overview.md §4.1` matrix made literal
  and is the enforcement point for SEAM-1.
- **Exit:** from inside the attacker Pod, the three allowed edges succeed and every
  other egress destination is refused; `redteam.sh` SEAM-1 passes on the local
  cluster.
- **Depends on:** M4 (Cilium), M6 (namespace + Pods to police).
- **Status — code + enforcement proven live on kind; the two internet-dependent
  assertions defer to H3.** Built as a **CiliumNetworkPolicy** (not a plain k8s
  NetworkPolicy): the model-API allow is by hostname (`toFQDNs`), which a plain
  NetworkPolicy — CIDR-only — cannot express, and hostname discrimination (openrouter
  allowed, `example.com` denied) is exactly what `redteam.sh` SEAM-1 tests. Layers,
  test-first, mirroring M6:
  - `k8s/manifests.network_policy_manifest` — the pure builder. **Namespace-wide**
    (empty `endpointSelector`), so it is the engagement namespace's default-deny
    baseline plus the allow-set — every Pod (attacker, target, probe) is governed,
    none left on Cilium's default-allow. Egress = 4 rules only (DNS→kube-dns with an
    L7 `dns` rule, target any-port, model API `toFQDNs` :443, control-plane :80);
    Cilium makes any selected endpoint default-deny, so "these four" *is* the deny of
    everything else.
  - `k8s/client.apply_network_policy` — applies the CRD via a `CustomObjectsApi`
    seam (`cilium.io/v2 ciliumnetworkpolicies`), injected the same way CoreV1 is.
  - `k8s/run.run_k8s` — applies the policy immediately after namespace create,
    **before any Pod**, and **fail-closed**: if the lockdown can't be applied the
    engagement records `failed` and never launches the attacker.
  - `k8s/factory.build_custom_objects` — the real `CustomObjectsApi`, kept in the
    one module allowed to import `kubernetes`.
  56 k8s unit tests green (13 new for M7).
  **Live proof (2026-09-24, kind `autosploit-hardening`, Cilium 1.21.0-pre.2 with
  Envoy L7 proxy up).** Applied the real builder output to an `engagement-m7live`
  namespace (target Pod+Service + a role=decoy Pod+Service) and probed from a
  curl Pod:
  - target Service `:8080` → **ALLOW** (http 200); in-cluster DNS `:53` → **ALLOW**
    (name resolves).
  - a decoy Pod identical to the target but `role=decoy` (not in the allow-set) →
    **DENY** (http 000); kube-dns pod on `:9153` (only `:53` allowed) → **DENY**.
  - causation control: with the policy deleted the decoy is reachable (200); on
    re-apply it is blocked again while the target stays allowed — the deny is the
    policy's, proven by toggling it.
  **Deferred to H3 (needs an online cluster — this kind node is air-gapped, no
  egress):** the model-API `toFQDNs` :443 ALLOW, the arbitrary-internet DENY
  discrimination, and the control-plane :80 ALLOW (no control-plane deployed here).
  The L7 DNS proxy (Envoy) is confirmed present, so `toFQDNs` will resolve once
  there is internet; these three ride the full `redteam.sh` SEAM-1 pass on the H3
  GKE deploy.

### M8 — Kaniko in-cluster target build — DONE (live on kind 2026-09-27)

- **Work:** build the user repo image **in-cluster with Kaniko** (no docker socket),
  push to the registry, and deploy the target Pod from the built image. **Dockerfile
  repos only** for MVP (compose deferred, see §5).
- **Exit:** a real Dockerfile repo goes clone → Kaniko build → push → target Pod
  running → attacker exploits it, with no docker socket anywhere in the path.
- **Depends on:** M6 (namespace + target deploy), M5 (registry path).
- **Proven:** `scripts/m8-proof.sh` runs the conductor's own manifests live on kind —
  registry Pod up → Kaniko build (gVisor, no docker socket) → push to the
  per-engagement HTTP registry (`--insecure`) → the node's containerd pulls the built
  image → the target Pod runs under gVisor (`uname -r` → `*-gvisor`) and serves. Two
  node-pull facts the live proof pinned down and `m4-bootstrap.sh` step 4b now sets:
  the node does **not** use coredns (so `registry.<ns>.svc` won't resolve there) and
  the registry is HTTP-only — solved by containerd `config_path` + a per-engagement
  `certs.d` `hosts.toml` mapping the registry name → `http://<ClusterIP>:5000`.
- **Egress ingestion — CLOSED by M5 (2026-09-28).** Under the M7 default-deny egress
  the build Pod can reach no external git host or base-image registry. M5 closed this:
  the conductor clones the repo conductor-side and mirrors external `FROM` bases into
  the per-engagement registry (`k8s/mirror.py`), so the build Pod stays air-gapped.
  Proven live under real egress by `scripts/m5-proof.sh`. See the M5 section.

### M9 — Engagement Helm chart — DONE (live on kind 2026-09-28)

- **Work:** package the per-engagement resources as a Helm chart the conductor
  installs per run. The current chart covers only the control plane.
- **Exit:** the conductor stands up an engagement by installing the chart and tears
  it down by deleting the release/namespace.
- **Depends on:** M6, M7, M8.
- **Status — DONE.** Built as `deploy/helm/engagement/` (chart) +
  `conductor/src/autosploit_conductor/k8s/helm.py` (an injectable
  `install_release`/`uninstall_release` seam, isolated the same way `k8s/factory.py`
  isolates the `kubernetes` client). `k8s/run.run_k8s` now stands the workload up with
  `helm.install_release(...)` and tears it down with `helm.uninstall_release(...)`
  before `delete_namespace()`. The four imperative builder calls the chart supersedes
  (`create_target_pod`, `create_target_service`, `apply_configmap`,
  `create_attacker_pod`) and their manifest/client builders were then deleted as pure
  cleanup. Landed test-first across five phases (chart render test, helm-seam unit
  tests, reworked `test_k8s_run`, dead-code removal, live proof); full k8s suite green.
  **Live proof:** `scripts/m9-proof.sh` (mirrors `m8-proof.sh`) — namespace + netpol
  imperative, `helm install` the chart with stand-in images (nginx target, curl
  attacker), attacker → target reachable and egress enforced, then `helm uninstall` +
  namespace delete with nothing left behind.
- **Deviation — namespace / netpol / secret stay imperative, only the workload is
  charted.** The chart renders the target Pod+Service, the attacker Pod, and the
  run-config; the `engagement-<id>` namespace, the CiliumNetworkPolicy default-deny
  baseline, and the model-key Secret are still applied imperatively by `run_k8s`
  *before* the release. Rationale: the M7 lockdown must be **fail-closed and in place
  before any Pod exists** (§M7) — if the netpol can't apply, the engagement records
  `failed` and never launches the attacker; folding it into the release would let the
  workload Pods and the policy race. The namespace must exist before either the policy
  or the release, and the Secret is a trusted conductor-side injection kept off the
  untrusted chart-values path. So the split is deliberate: imperative security
  scaffold first, then Helm for the workload.

### H3 — Exit gate: red-team green on real GKE

- **Work:** run `scripts/redteam.sh` (SEAM-1 egress matrix, SEAM-2 secret split)
  against a **live GKE deploy** with the real NetworkPolicy in place. The script and
  the `release.yml` GKE step already exist; this is the first green run against a
  real cluster.
- **Exit:** `redteam.sh` passes on GKE. **This closes step 3.**
- **Depends on:** M6–M9, plus `deploy/terraform` GKE stand-up.

---

## 4. Dependency spine

```
M4 (cluster + Cilium + gVisor)
 ├─ M5 (harness image + in-cluster repo/base mirror)
 └─ M6 (conductor as k8s controller) ── M6a (scope 1.1.0)
      ├─ M7 (NetworkPolicy / egress matrix)
      ├─ M8 (Kaniko target build)
      └─ M9 (engagement Helm chart)
            └─ H3 (redteam.sh green on GKE)  ── closes step 3
```

Critical path: **M4 → M6 → M9 → H3.** M5, M7, and M8 hang off M6 and can proceed in
parallel once the controller exists. M6a rides with M6.

---

## 5. Out of scope (deferred, do not pull in)

Tracked in `deferred-open-items.md`; listed here so the step stays bounded:

- **Compose targets.** MVP builds Dockerfile repos via Kaniko only; `docker-compose`
  targets fight the single-Pod model (`orchestration.md §7`).
- **Multi-service target scope.** Multiple target hosts is an additive contract
  change beyond the M6a DNS bump.
- **Buildpack / Nixpacks fallback.** Leaning deferred permanently.
- **Image supply-chain hardening (H-Q5).** SBOM, cosign signing, provenance — an
  additive next step on the release workflow.
- **Concurrency-cap race (Q2 / H-Q3).** A correctness nicety on a soft cap, not a
  security seam.
- **Harness `traceparent` emission (H-Q2).** Accepted degradation; `engagement_id`
  correlation already holds.

---

## 6. Invariant that governs the whole step

The one rule that drives the component split, from `orchestration.md §2`: **code
that handles untrusted input never shares a component with code that holds
secrets.**

| Role | Handles | Holds model key? |
|------|---------|------------------|
| **Provisioner** | user repo, arbitrary Dockerfiles, build output (untrusted) | never |
| **Conductor** | engagement lifecycle, harness launch, teardown (trusted) | yes |
| **Harness** | the agent loop, tool calls (our code) | yes (injected) |

Naming trap to keep straight: the attacker Pod also needs "setting up" (pull image,
inject scope + key). That is the **attacker launcher** — a trusted sub-step inside
the conductor — **not** the provisioner. Same English word, two trust levels; keep
them distinct in code and review.

---

## 7. First move

**M4–M9 and M6a are all done** (see their milestones). One item remains before H3
closes step 3:

1. **H3 — the exit gate.** Stand up the `deploy/terraform` GKE cluster and run
   `scripts/redteam.sh` green against the real NetworkPolicy. This is the critical
   remaining work and absorbs the three M7 SEAM-1 assertions deferred for want of an
   online cluster. **This closes step 3.**

> Original first move (M4), now complete: local kind cluster + Cilium CNI + gVisor
> `RuntimeClass`, then cut the conductor over from subprocess to the `kubernetes`
> client (M6).
