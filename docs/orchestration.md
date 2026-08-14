# Autosploit — Orchestration, Provisioning & Isolation

> **Status: design (2026-08-08).** Specifies the two planes that stand up and tear
> down an engagement: the **target provisioner** (overview §4 plane 4) and the
> **orchestration / conductor** (overview §3 plane 3), plus the isolation model
> (overview §4). The attack engine (harness) is already built (`harness/`, build
> order §9 complete). This doc covers everything *around* the harness that makes it
> run against a real deployed repo, safely, at more than one at a time.

---

## 1. Where this sits

The harness is the attacker. It reads an immutable **scope file** and attacks a
running target, emitting an event stream. It does **not** deploy targets, spin up
sandboxes, hold secrets, or manage its own lifecycle. Everything that does is
specified here.

```
overview plane 3  ORCHESTRATION / CONDUCTOR   owns the engagement, holds the secret
overview plane 4  TARGET PROVISIONER          repo -> running target -> scope file
this doc          ISOLATION MODEL             k8s namespace + gVisor + NetworkPolicy
harness/ (built)  ATTACK ENGINE               reads scope, attacks, streams events
```

---

## 2. Two roles, one trust boundary

The single most important decision in this layer: **the code that handles untrusted
input must never share a component with the code that holds secrets.**

| Role | Handles | Trust | Holds the model API key? |
|------|---------|-------|--------------------------|
| **Provisioner** | user repo, arbitrary Dockerfiles, build output | **untrusted** | never |
| **Conductor** | engagement lifecycle, harness launch, teardown | trusted | **yes** |
| **Harness** (built) | the agent loop, tool calls | trusted (our code) | yes (injected) |

The provisioner builds and runs code we did not write. The conductor launches our
own harness image and injects the `OPENROUTER_API_KEY`. Keeping them separate means
a bug in repo-handling cannot reach the secret. This is a security control, not
tidiness — it drives the component split below.

There is a naming trap worth calling out: the attacker sandbox also needs "setting
up" (pull the harness image, inject scope + config + key). That is **not** the
provisioner — it is the **attacker launcher**, a trusted sub-step inside the
conductor. Same English word ("provision") for two trust levels caused real
confusion; the names are deliberately distinct.

---

## 3. The load-bearing decision: Kubernetes as the orchestration substrate

Overview plane 3 (orchestration), §4 (isolation + egress deny), and §5 step 11
(teardown) describe, almost line for line, what Kubernetes primitives already do.
So the conductor is not hand-rolled — it is a **Kubernetes job controller**. Every
orchestration concept maps to a native object:

| Requirement (overview) | Kubernetes primitive |
|------------------------|----------------------|
| one sandbox per engagement (§3) | one **Namespace** per engagement |
| isolation, not plain Docker (§4) | **gVisor** `RuntimeClass` on every Pod |
| default-deny egress, allow target + model (§4.1) | **NetworkPolicy** (Cilium CNI) |
| provision then tear down (§5.4, §5.11) | create namespace / **delete namespace** |
| build untrusted repo safely | **Kaniko** (in-cluster build, no docker socket) |
| nothing offensive outlives the run (§5.11) | namespace TTL + conductor delete |

Choosing K8s is defensible precisely because each primitive answers a requirement
that already existed — nothing is added for its own sake.

### 3.1 What we deliberately do NOT use

- **Firecracker / Kata microVMs** — real, but overkill here; gVisor gives the
  "real isolation" story at drop-in cost.
- **Istio / service mesh** — no cross-service traffic management need.
- **Kafka** — *(superseded — see `control-plane.md §8.2, §9.1)`.* Held true while the
  event stream had a single consumer (SSE). The control plane later gives it multiple
  independent consumers (SSE bridge, Postgres projector, S3 sink, audit, quota), which
  **is** the bus requirement — so Kafka (Redpanda) is adopted there. The rejection was
  correct for the narrower requirement; the requirement grew.
- **ArgoCD / GitOps** — engagements are imperative, ephemeral jobs, not declarative
  desired-state to reconcile.

Each of these would be a keyword with no matching requirement.

---

## 4. Engagement topology — one Namespace per run

```
Namespace: engagement-<id>                         delete namespace == full teardown
│
├─ Pod: attacker   image: ghcr.io/.../harness      RuntimeClass: gvisor
│     env: OPENROUTER_API_KEY (from Secret), scope.yaml + run.toml (mounted)
│
├─ Pod: target     image: <built from user repo>   RuntimeClass: gvisor
│
├─ Service: target                                 stable DNS for the attacker
│     target.engagement-<id>.svc.cluster.local:<port>
│
└─ NetworkPolicy: default-deny egress
      ALLOW  attacker -> target Service
      ALLOW  attacker -> model API (FQDN / CIDR)
      ALLOW  attacker -> control plane (events)
      DENY   everything else                       == overview §4.1 matrix, literal
```

Key point: the attacker reaches the target **over the cluster network via a
Service**, not over `localhost`. The pentest stays realistic (real network path,
real DNS) and NetworkPolicy becomes the enforcement point for §4.1.

### 4.1 Scope contract impact

The harness scope file today is `target: {host: 127.0.0.1, ports: [...]}`
(single host + ports, frozen seam, contract v1.0.0). Under k8s the target host
becomes a Service DNS name rather than a loopback IP. That is an **additive
(MINOR) contract change**: the `host` field carries a DNS name instead of an IP —
same shape, wider value domain. Bump `CONTRACT_VERSION` to `1.1.0` when the
provisioner starts emitting Service DNS. Multi-service compose (multiple target
hosts) is a further additive change, deferred (see §7).

---

## 5. Target provisioner — components & tasks

Deploys the user repo into the target Pod and emits the scope file. Handles
untrusted code only; never sees the model key.

| # | Component | Tasks |
|---|-----------|-------|
| 1 | **Repo cloner** | shallow `git clone --depth 1` into ephemeral workdir; token from env, never logged; also accepts local path / prebuilt image |
| 2 | **Build resolver** | ladder MVP: `Dockerfile` present -> Kaniko build. `docker-compose.yml` -> deferred (see §7). Neither -> reject with clear message. Detection only, no language sniffing |
| 3 | **Image builder** | **Kaniko** Job builds the repo image in-cluster (no docker socket) and pushes to the registry |
| 4 | **Target deployer** | create target Pod + Service in the engagement namespace from the built image; apply gVisor RuntimeClass |
| 5 | **Health + port discovery** | poll readiness; determine the exposed container port(s); pick the web entrypoint |
| 6 | **Scope emitter** | write `target: {host: <Service DNS>, ports: [...]}`; self-validate it round-trips through harness `load_scope` before declaring ready |
| 7 | **Manifest** | emit `provision.json`: engagement id, repo ref + commit, build branch, image ref, service DNS, ports, timestamps |

The provisioner produces the scope file; the harness consumes it. That file is the
only contract between them.

---

## 6. Conductor — components & tasks

Owns the engagement end to end. Trusted; holds the model API key. This is the K8s
job controller (overview plane 3), thin at first, richer later.

| # | Component | Tasks |
|---|-----------|-------|
| 1 | **Namespace manager** | create `engagement-<id>` namespace; apply default-deny NetworkPolicy + RuntimeClass defaults |
| 2 | **Provision step** | invoke the provisioner (§5); receive scope.yaml + provision.json |
| 3 | **Attacker launcher** | mount scope.yaml + run.toml; inject `OPENROUTER_API_KEY` from a K8s Secret; start the attacker Pod (harness image) |
| 4 | **Watcher** | watch the attacker Pod to completion; surface the harness event stream / report |
| 5 | **Teardown** | delete the namespace (attacker + target + Service + policy go with it); idempotent; runs on success, failure, and interruption |
| 6 | **Quota (later)** | per-user concurrent-engagement cap before namespace create (overview §3) |

---

## 7. Deferred / known limits

- **Compose branch under k8s.** `docker-compose.yml` targets fight the single-Pod
  model. MVP builds **Dockerfile repos via Kaniko** only. `kompose` conversion or a
  per-service Deployment set is the future path; deferred to keep the isolation
  story clean.
- **Multi-service target scope.** Multiple target hosts (app + db + cache each on
  their own Service) is an additive contract change beyond the DNS bump in §4.1.
- **Managed cloud.** Local **k3s / kind** is the dev substrate. **GKE Autopilot**
  (or EKS) is the demo substrate, spun up only when needed to keep cost near zero.
- **Buildpacks** (overview §2.1 step 3) — still deferred.

---

## 8. Tech stack summary

Every entry traces to a requirement above; none is decorative.

| Layer | Tech | Serves |
|-------|------|--------|
| Orchestration | **Kubernetes** (Namespace / Pod / Job / Service) | plane 3, per-engagement lifecycle |
| CNI + egress | **Cilium** + **NetworkPolicy** | §4.1 default-deny egress matrix |
| Isolation | **gVisor** (`RuntimeClass`) | §4 real isolation, drop-in |
| In-cluster build | **Kaniko** | build untrusted repo without docker socket |
| Packaging | **Helm** | engagement resources as a chart |
| IaC | **Terraform** | provision cluster + registry + IAM |
| CI/CD | **GitHub Actions** | build / scan / push harness image |
| Registry | **GHCR** | image distribution |
| Cloud (demo) | **GKE Autopilot** / EKS | the managed-cloud story |
| Dev cluster | **k3s / kind** | free local substrate |
| Conductor client | Python **`kubernetes`** client (or client-go) | drive the API from the conductor |

Resulting resume surface, all interview-defensible:
`Kubernetes · NetworkPolicy · Cilium · gVisor · Kaniko · Helm · Terraform ·
GitHub Actions · GHCR · GKE`.

---

## 9. Build order (this layer)

Extends overview §6. The harness (attack engine) is done; the loop is proven
against a hand-run Juice Shop. From here:

**Phase A — close the deploy loop on one machine (no k8s yet).**
Prove deploy-then-attack end to end before adding the cluster.
1. **Provisioner (local Docker)** — clone repo, Dockerfile -> `docker build` +
   `run -P`, health + port discovery, emit `scope.yaml`.
2. **Conductor (thin script)** — call provisioner -> run harness as a local
   subprocess against the emitted scope -> collect report -> teardown.
3. **First real proof** — a real repo (Juice Shop from its Dockerfile) goes
   `repo -> running app -> autonomous exploit -> report`, target stood up by the
   provisioner, not hand-run.

**Phase B — put it on Kubernetes.**
Move the same two roles onto the cluster; add isolation + egress control.
4. **Local cluster** — k3s / kind via Terraform (or shell), **Cilium** CNI.
5. **Harness image + CI** — GitHub Actions build/scan/push to **GHCR**.
6. **Conductor as k8s controller** — namespace per engagement; attacker + target
   Pods; **Service** for the target; **gVisor** RuntimeClass; run loop; delete
   namespace. Scope host becomes Service DNS -> contract bump **1.1.0**.
7. **NetworkPolicy** — default-deny egress; allow attacker->target, attacker->model
   API, attacker->control plane. The §4.1 matrix enforced.
8. **Kaniko target build** — build the user repo in-cluster; push; deploy target
   from the built image.
9. **Helm chart** — package the engagement resources; conductor installs per run.

**Phase C — control plane & scale (overview §6 steps 2-4).**
10. **Control plane (TS)** — auth (GitHub OAuth), Postgres engagement CRUD, Redis
    queue, streaming gateway, repo picker + live dashboard.
11. **Quotas + teardown-at-scale** — per-user concurrency cap; namespace TTL.
12. **Managed cloud (demo)** — lift onto GKE Autopilot / EKS.

Rationale: Phase A proves the core idea (overview §6 step 1) with the least moving
parts. Phase B is where the DevOps / cloud surface is earned — and it is earned,
because each piece answers a real requirement. Phase C turns the demo into a
platform.
