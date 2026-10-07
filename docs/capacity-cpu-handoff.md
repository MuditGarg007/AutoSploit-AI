# Capacity & CPU on the single Contabo box — handoff

**Date:** 2026-10-07
**Branch:** `main`
**Local HEAD at handoff:** `d76d16d`
**Measured on:** Contabo VPS `root@169.58.86.230`, repo rev `2cf5ee6` (one commit
behind local `main`; architecture identical for everything below)
**Status:** investigation complete, measured live on the VPS. **Tier A (A1 + A2)
implemented 2026-10-07** (see §5); B-levers below are still proposals, not
implemented.

## 0. Implemented (Tier A, 2026-10-07)

- **A1** — `WORKER_CONCURRENCY` env knob (default 3), `control-plane/src/config/env.service.ts`
  `workerConcurrency` (clamped to ≥1, falls back to 3 on a non-integer/<1 value) →
  wired into the BullMQ Worker in `lifecycle.module.ts`.
- **A2** — build gate `conductor/src/autosploit_conductor/k8s/build_gate.py`: a
  cross-process counted semaphore in Redis (sorted-set-with-lease, self-expiring
  slots), injected into `phaseb_provision` as `gate_fn` and wrapping **only** the
  CPU-heavy build stretch (conductor-side clone/`crane copy` + the Kaniko build
  Pod); the registry setup and scope emit stay ungated, and the long attack phase
  in `run_k8s` never holds a slot. **Fail-open**: unset (`REDIS_URL` /
  `BUILD_CONCURRENCY`) or an unreachable Redis ⇒ builds run ungated (today's
  behaviour); an acquire that cannot win a slot within `BUILD_GATE_WAIT_S` also
  proceeds ungated rather than deadlocking.

  New conductor env: `REDIS_URL`, `BUILD_CONCURRENCY` (gate off unless both set;
  recommend `2`), optional `BUILD_GATE_LEASE_S` (default 1200), `BUILD_GATE_WAIT_S`
  (default 1800), `BUILD_GATE_POLL_S` (default 0.5). Deploy note: set
  `WORKER_CONCURRENCY=3` **and** `BUILD_CONCURRENCY=2` together — A1 without A2
  lets 3 concurrent engagements hit the build phase at once (§6).

Still open: **B1** (Kaniko CPU flags) is the recommended next step, then B2.

## 1. The question

Budget constraint: this project stays on the existing Contabo instance —
**4 vCPU, 8 GB RAM** — rather than a larger box. Two things needed answering:

1. How many engagements can this instance reliably run concurrently?
2. Should we offload services (Postgres → Neon, etc.) to free up headroom, or
   solve it another way?

Everything here was measured on the live VPS, not estimated, except the one item
explicitly flagged as an estimate in §3.

## 2. How the system runs an engagement (the relevant path)

Each engagement, as driven by the real control-plane path:

1. A request is accepted and a BullMQ job is enqueued (Redis-backed).
2. `EngagementWorker` dequeues it and `spawn`s `conductor run <repo>
   --engagement-id <id> …`, then **awaits that child process to exit**
   (`control-plane/src/domains/lifecycle/worker/engagement.worker.ts:51`,
   `:102`, `waitForExit`).
3. The conductor, per engagement, runs **synchronously end to end**
   (`conductor/src/autosploit_conductor/k8s/provision.py:60` `phaseb_provision`):
   - stand up a per-engagement in-cluster **registry** Pod + Service;
   - prepare the build context conductor-side — clone, `crane copy` each external
     `FROM` base into the per-engagement registry (`mirror.py` `mirror_base_image`,
     shelled out **inside the control-plane pod**), pack the workdir into a
     `dir://` ConfigMap;
   - run the **Kaniko** build Pod → push to the registry;
   - deploy the **target** Pod + the **attacker** (harness) Pod;
   - the attacker runs the agent loop against the target, mostly **waiting on the
     OpenRouter model API** — long wall-clock, near-zero local CPU;
   - teardown is `delete_namespace`.

Every engagement Pod runs under the gVisor RuntimeClass (`runtimeClassName:
gvisor`, `restartPolicy: Never`). Egress is default-deny with an FQDN allow for
`openrouter.ai` (Cilium + its DNS proxy / envoy — load-bearing for that policy).

**Two cost regimes per engagement:**

- **Build phase** — short, **CPU-bound** (Kaniko layer snapshotting + gzip
  compression on push; plus the conductor-side `crane copy`).
- **Attack phase** — long, **network-bound / CPU-idle** (waiting on the model API).

## 3. Measurements (live on the VPS)

**Idle floor (control plane only, one engagement resident):**
- ~2.0 GB RAM used, ~5.9 GB available, 6 GB swap essentially untouched.
- Load ~1–2. The control plane alone burns ~1 full core at rest: `kube-apiserver`
  ~13 % CPU + `cilium-agent` ~15 % are the two biggest idle consumers.

**Per-engagement footprint (measured via `crictl stats` + host `ps`/`free`):**
- registry pod: ~25 MB working set each.
- gVisor `runsc` host overhead: ~22 MB **per Pod** (16 runsc processes totalling
  355 MB for 8 gVisor Pods).
- target (busybox-class app): ~26 MB. A real user app varies.
- attacker harness: **not run live this session — estimate ~100–200 MB** Python
  RSS, near-zero CPU (network-bound). Flagged as the one unmeasured number; in the
  current rev the target/attacker Pods are rendered by the Helm engagement chart,
  not by `manifests.py`, so the live test exercised the heavy half (registry +
  Kaniko build + gVisor) with real manifests and left the light half estimated.
- **Sustained ≈ 250–350 MB RAM per engagement, ~0 CPU during the attack phase.**

**Concurrency stress test** (8 engagements driven straight at the cluster via the
real conductor manifest builders, busybox target, no LLM, in their own
`engagement-cap*` namespaces — h3gate untouched; all cleaned up afterwards):
- 8 registries + 8 completed Kaniko builds added only ~450 MB; MemAvailable never
  dropped below ~5.4 GB. **Memory was never stressed.**
- 8 **concurrent** Kaniko builds drove load to **5+ on 4 cores** — builds are
  CPU-bound and saturate the cores. No OOM.
- Practical build concurrency before CPU saturation: **~2–3 simultaneous builds.**

## 4. Findings

**4.1 — Memory is not the limiter. CPU is.**
On RAM alone the box holds ~15–20 sustained engagements; a safe reliable figure
leaving build + unknown-target headroom is ~10–12. The binding constraint is CPU,
and only during the build phase (and the ~1 idle core the control plane already
eats). The attack phase is free — it waits on the network.

**4.2 — CPU is currently *wasted*, not scarce.**
`control-plane/src/domains/lifecycle/lifecycle.module.ts:49` creates the BullMQ
Worker with **`concurrency: 1`**, hardcoded. Because the worker awaits the whole
engagement child (§2 step 2), **exactly one engagement runs end to end at a time,
globally** — including through the long, CPU-idle attack phase — while 3 cores and
~5.8 GB sit idle. The build "thundering herd" is not currently reachable through
the real path; it is already serialized to one.

So there are two distinct goals, with two lever sets:
- **A — use the idle CPU** (raise effective concurrency).
- **B — cut the CPU each engagement costs** (the literal "use less CPU" ask).

**4.3 — Offloading services to external providers does not help and is harmful.**
Postgres on the box uses **~28 MB**. Offloading it to Neon saves nothing on the
real bottleneck (CPU), and it:
- punctures the trust boundary — a managed external service is a new egress edge
  the M7 default-deny policy must now permit, i.e. a hole in exactly the isolation
  this project exists to enforce;
- adds recurring cost, latency, and a new failure/dependency mode.
Same logic rejects offloading Redis/object-store/etc. **Do not offload to free
RAM that is not the constraint.** If the box is ever genuinely outgrown, the
in-trust-boundary move is a second cheap Contabo node joined to the cluster
(horizontal), not managed external services.

## 5. Proposed levers, ranked

ROI = impact ÷ (effort · risk). Nothing here is implemented yet.

| # | Lever | Type | Win | Effort | Risk |
|---|-------|------|-----|--------|------|
| 1 | A1 — worker concurrency → 3 (env-driven) ✅ done | capacity | ~3× throughput | tiny | low (pair with A2) |
| 2 | A2 — gate only the build phase ✅ done | capacity | unlocks ~8–10 concurrent | medium | low |
| 3 | B1 — Kaniko CPU flags | CPU cut | large per build | small | low |
| 4 | B2 — build cache / skip rebuilds | CPU cut | ~100 % on re-runs | medium | medium |
| 5 | B3 — lengthen poll intervals | CPU cut | small | tiny | low |
| 6 | B4 — pin gVisor `platform=systrap` | CPU cut | marginal (verify) | tiny | low |
| — | B5 — drop redundant kube-proxy | — | **skip** | — | high |

### A1 — Make worker concurrency an env knob, default 3
`lifecycle.module.ts:49`: `concurrency: 1` → `concurrency: env.workerConcurrency`
(new env, e.g. `WORKER_CONCURRENCY`, default 3). The attack phase is network-bound
(~0 CPU), so ~3 engagements overlap comfortably. Biggest ROI on the box: it does
not cut CPU, it stops wasting the 3 idle cores. **Must ship with A2** — otherwise
two engagements can hit the CPU-heavy build phase at the same time.

### A2 — Gate only the build phase, not the whole engagement
The build is the sole CPU-heavy stretch; the attack phase is idle. Let many
engagements run concurrently (attack phases overlap freely), but pass the
CPU-heavy build steps — the Kaniko build Pod **and** the conductor-side
`crane copy` (which runs inside the 500m-capped control-plane pod,
`provision.py` `_prepare_build_context` / `mirror.py`) — through a build gate of
~2 (a Redis lock, or a separate low-concurrency BullMQ "build" queue). Decouples
the long idle phase from the short heavy phase, so the memory-bound ceiling
(~8–10) is reached without any build thundering.

### B1 — Add Kaniko CPU flags
`conductor/src/autosploit_conductor/k8s/manifests.py` `kaniko_build_pod_manifest`
currently passes only `--context --dockerfile --destination --insecure`
(+ mirror flags). Append:
- `--use-new-run` and `--snapshot-mode=redo` — remove the full-filesystem-walk
  snapshot CPU (the hot path);
- `--single-snapshot` — one layer, less diffing (fine for single-stage targets);
- `--compression-level=1` (optionally `--compression=zstd`) — layer gzip on push
  is the push-side CPU hog; level 1 is a large cut vs the default;
- `--compressed-caching=false` — less CPU and RAM.
Append-only, well-trodden flags. Best CPU-cut ROI.

### B2 — Build cache / skip unchanged rebuilds
Kaniko `--cache=true --cache-repo=<shared internal registry>`, or content-hash the
build context and reuse the prior image when unchanged. A re-run of an unchanged
target then skips the entire build — 100 % of build CPU gone. Needs a long-lived
**internal** cache registry (the per-engagement one is ephemeral); keep it inside
the trust boundary. Big win if users re-run the same target.

### B3 — Lengthen poll intervals
`conductor/src/autosploit_conductor/k8s/watch.py` polls the Pod `status.phase`
every `poll_interval_s` for the whole (long) attack run; each poll hits the
already-busy apiserver. Raising the interval (e.g. 2 s → 5 s) shaves apiserver
churn. Small absolute win, one-line, near-zero risk (slightly slower terminal
detection).

### B4 — Pin gVisor `platform=systrap`
The VPS has **no `/dev/kvm`** and no `vmx`/`svm` in `/proc/cpuinfo` (no nested
virt), so the gVisor KVM platform is unavailable. runsc already defaults to
`systrap` (the fast successor to ptrace), so this is a *verify / pin* in the runsc
runtime options to guard against a ptrace fallback — not a real gain.

### B5 — Do NOT drop kube-proxy (recorded so it isn't retried)
`scripts/m4-bootstrap.sh:68` installs Cilium with `kubeProxyReplacement=false`
alongside kube-proxy (double networking stack). Dropping kube-proxy would shave a
little CPU, but this was deliberate: socketLB/BPF cgroup-socket paths are fragile
on this kernel (see memory `m4-cilium-kernel-quirk`), which is why kube-proxy was
kept and `socketLB`/`kubeProxyReplacement` disabled. High risk for ~17 MB + minor
CPU — not worth it. Likewise **do not** remove Cilium envoy / the DNS proxy: it is
load-bearing for the FQDN egress policy (`openrouter.ai`), i.e. the security
feature itself.

## 6. Answer & recommendation

- **Reliable concurrent engagements today:** 1 (artificially — `concurrency: 1`).
  The hardware supports **~8–10** once the software stops serializing, with a hard
  sub-limit of **~2–3 simultaneous builds**.
- **Do A1 + B1 first.** Both are near-trivial, add no new components, and change
  nothing about the trust boundary: A1 roughly triples throughput by using the
  idle cores, B1 cuts each build's CPU. Ship A2 with A1 so concurrent builds stay
  gated.
- **Add A2 next** to reach the full memory-bound ceiling; **B2** after that if
  users re-run targets. B3/B4 are cheap cleanups.
- **Do not offload anything to Neon or other managed services** — it does not
  touch the real (CPU) constraint and it weakens the isolation model. Scale
  horizontally with a second cheap node only if genuinely outgrown.

## 7. Reproducing the measurement

The stress harness used this session lives only as a scratch script
(`capacity-test.sh`): for N engagement ids it renders the real conductor
manifests (`namespace` → `registry` pod+service → node `certs.d` pull map →
`build-context` ConfigMap → Kaniko build → waits), launches waves in parallel, and
samples `free` / load throughout, then deletes the `engagement-cap*` namespaces
and their `certs.d` entries. It mirrors `scripts/m8-proof.sh`. Re-create from that
proof script if the numbers need re-checking after a kernel/Cilium/gVisor bump.
Run it in throwaway namespaces and never against a live engagement's namespace.
