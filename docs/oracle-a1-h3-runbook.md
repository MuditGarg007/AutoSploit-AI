# H3 on an Oracle Cloud Always-Free A1 VPS — Runbook

> **Status: ready to execute (2026-09-28).** This runbook closes the isolation-hardening
> exit gate (H3) on a **single Oracle Cloud Infrastructure (OCI) Ampere A1 instance**
> (`VM.Standard.A1.Flex`, **2 OCPU / 12 GB RAM**, aarch64). H3 = `scripts/redteam.sh`
> green against the real CiliumNetworkPolicy under live egress.
>
> It is the **ARM sibling** of `vps-h3-runbook.md` (the Hostinger KVM2 x86 plan) and a
> companion to `isolation-hardening-roadmap.md`. The roadmap stays the authority for *why*
> each seam is shaped the way it is. Read the KVM2 runbook alongside this one: every section
> that is **identical** is only summarized here, and this file spells out **only the deltas**
> that Oracle + ARM introduce.

Running self-hosted is consistent with the settled isolation decision
(`deferred-open-items.md`: self-hosted K8s + gVisor, managed microVM rejected). The
application layers (conductor, harness, provisioner, the `k8s/` controller) are
substrate-agnostic and need **no source changes**. The **one** thing this substrate forces
that KVM2 did not is an **architecture port to `linux/arm64`** for every image — that is the
whole tax of going Oracle, and §A below is dedicated to it.

---

## 0. Why Oracle A1, and the two things to accept first

Chosen for cost: the A1 shape is **Always Free**, so the box is $0/month versus the paid
KVM2. In exchange, accept two Oracle-specific realities up front:

1. **Everything is aarch64.** Ampere A1 is an ARM64 core. Any image that runs on the box —
   harness (attacker), conductor, provisioner, and every Kaniko-built *target* — must have a
   `linux/arm64` variant. This is real work and is covered in **§A**.
2. **The free A1 shape is scarce and reclaimable.**
   - **Provisioning** frequently returns `Out of host capacity`. Expect to retry, or script
     the retry (§1.1).
   - **Idle Always-Free instances can be reclaimed** by Oracle. For a demo box that a
     recruiter may hit at any time, that is a real "it vanished" risk. **Mitigation: upgrade
     the tenancy to Pay-As-You-Go (PAYG).** PAYG requires a card but stays $0 at this usage,
     and **PAYG tenancies are not subject to idle reclaim.** Do this before relying on the
     box for a demo.

> **On the OCPU limit.** As of the June 2026 change, Oracle's *documented* Always-Free A1
> allowance is **2 OCPU / 12 GB** for **all tenancies** (1,500 OCPU-hours + 9,000 GB-hours
> per month). Reports that PAYG accounts keep the old 4 OCPU / 24 GB are **unconfirmed
> support-email hearsay** — **plan for 2 OCPU / 12 GB.** If you actually get 4/24, treat it
> as bonus headroom, not a design assumption.

Note one upside: an A1 **OCPU is a full physical core** (no SMT sibling), so "2 OCPU" is
mildly stronger than KVM2's "2 vCPU" hyperthreads. The Kaniko-is-slow constraint (§2) still
holds, just slightly less painful.

---

## 1. What runs where

Identical split to the KVM2 runbook — the expensive substrate (kind + Cilium + gVisor +
Kaniko) lives **on the A1 box**; only the harness image **build** and report blobs move off.

| On the A1 VPS (always-on) | Off-box |
|---|---|
| kind node = k8s control plane | Harness image build → **GitHub Actions → GHCR**, now **multi-arch incl. `linux/arm64`** (§A.1) |
| Cilium CNI + Envoy L7 DNS proxy | Report blobs → **Cloudflare R2** (free, S3-protocol) |
| gVisor `RuntimeClass` (systrap) | |
| Conductor (k8s controller, holds model key) | |
| Provisioner + **Kaniko target builds** (untrusted, arm64) | |
| Per-engagement target + attacker/harness Pods | |
| Control-plane ingest (`:80`, in-cluster) | |
| Per-engagement registry, minimal Vault | |

Hard rule unchanged: **nothing that holds a secret, ingests engagement traffic, or is a
SEAM-1 egress edge leaves the VPS.** The CiliumNetworkPolicy inside the cluster is the SEAM-1
enforcement point — **keep host-level egress permissive** (Oracle adds two layers of host
egress control; see §1.2), or you mask the very thing `redteam.sh` proves.

### 1.1 Provisioning the instance (out-of-band, like KVM2)

OCI has a Terraform provider, but for a one-box demo the console is faster. Create the
instance in the OCI console:

- **Shape:** `VM.Standard.A1.Flex`, **2 OCPU / 12 GB**.
- **Image:** **Ubuntu 22.04 (aarch64)** — matches the KVM2 runbook's Ubuntu assumptions
  (BTF, eBPF, apt tooling) and keeps kernel-feature parity. (Oracle Linux 9 aarch64 also
  works but diverges on firewall tooling; stick with Ubuntu to reuse the KVM2 steps.)
- **Boot volume:** bump to ~100 GB (Always-Free allows up to 200 GB of block storage total;
  100 GB matches the KVM2 NVMe budget with room for the swapfile in §4.3).
- **SSH key:** your key.

If creation fails with **`Out of host capacity`**, either retry in another Availability
Domain, or run a small retry loop against `oci compute instance launch` until it lands (this
is the well-known A1 scarcity dance — not a bug in this plan).

**Then upgrade the tenancy to PAYG** (Billing → Upgrade to Pay As You Go) to remove the
idle-reclaim risk before you depend on the box for a demo (§0).

### 1.2 Oracle's two host-egress / ingress layers — open them, keep egress permissive

Unlike a plain KVM VPS, OCI gates traffic in **two** places. Both must allow the flows H3
needs, and neither must clamp cluster egress (SEAM-1 must live *inside* the cluster):

1. **VCN Security List / Network Security Group (cloud firewall).** By default a VCN allows
   all egress and only SSH ingress. **Leave egress fully open.** Add ingress only for what
   you actually reach from outside (e.g. SSH; and any port you use to demo). The in-cluster
   ingest `:80` does not need a public ingress rule — it is reached in-cluster.
2. **Host firewall on the Ubuntu image.** OCI Ubuntu images ship **restrictive `iptables`
   rules** (and the `iptables`/netfilter-persistent package) that will interfere with kind +
   Cilium. Before bootstrap, clear the OCI-injected filter rules so Cilium/kube-proxy manage
   the chains, e.g. flush the default `INPUT`/`FORWARD` reject rules the image ships, and
   persist the cleared state. **Do not** add a host-level egress DROP — SEAM-1 is the
   CiliumNetworkPolicy, not the host.

> This is the single biggest operational gotcha versus KVM2. If the smoke test or `redteam.sh`
> sees weird connectivity, suspect these two layers first.

---

## 2. Constraints on A1 — read first

Same shape as the KVM2 constraints, adjusted for ARM:

- **2 OCPU is the bottleneck**, not RAM (12 GB is generous here). gVisor, Cilium eBPF, and
  Kaniko share 2 cores. Builds are **slow but correct**. H3 is probe-heavy with tiny Pods, so
  it runs comfortably; heavy target builds are the only thing that crawls.
- **One engagement at a time.** Keep the concurrency cap at **1** (Q2). 12 GB gives
  comfortable headroom (§6) but not a second concurrent engagement.
- **Virtualization: A1 is a hardware VM with a full kernel and loadable modules** — kind and
  gVisor run. But **nested `/dev/kvm` is not exposed to `runsc`**, so **gVisor uses the
  `systrap` platform** (no `/dev/kvm` needed). Same outcome as KVM2, arrived at differently —
  acceptable for the exit gate and MVP.
- **Kernel must expose eBPF + BTF** for Cilium. Ubuntu 22.04 aarch64 ships this. Verify
  `/sys/kernel/btf/vmlinux` exists (§4.2).
- **Everything is arm64** — see **§A**. A target repo whose `FROM` base has **no arm64 image**
  simply cannot be built here; pick arm64-capable demo targets, or use the burst box (§8).

---

## A. The architecture port (the whole Oracle tax)

This section has **no KVM2 equivalent** — it is the price of the free box.

### A.1 Harness image → multi-arch in CI

`.github/workflows/release.yml` builds/scans/pushes the harness (attacker) image to GHCR.
Today it is `linux/amd64`. Make it **multi-arch**:

- Build with `docker buildx build --platform linux/amd64,linux/arm64` (QEMU emulation on the
  GitHub x86 runner, or a native arm64 runner for speed) and push a manifest list.
- The VPS still pulls **by digest** (`AUTOSPLOIT_HARNESS_IMAGE`); a manifest-list digest
  resolves to the arm64 image automatically on the A1 node. Confirm the arm64 variant exists
  in GHCR before H3.
- Re-run the image scan for the arm64 layers.

### A.2 Conductor / provisioner images → arm64

The conductor image (with `git` + `crane` for the M5 mirror path, commit `fab666c`) and any
provisioner image must publish `linux/arm64`. Same buildx multi-arch treatment. Verify
`crane` and `git` binaries in the arm64 image actually run on the node (they are Go/arm64
native — fine, but confirm).

### A.3 Kaniko + target builds → arm64 only

- Use the **arm64 Kaniko executor** image (`gcr.io/kaniko-project/executor` publishes arm64).
- **Every target Dockerfile's `FROM` must resolve to an arm64 image.** The in-cluster
  repo/base mirror (M5, `4045fc7`/`6652043`) must therefore mirror arm64 bases. Pick H3 demo
  targets whose bases are arm64-published (most official images are multi-arch).
- The per-engagement registry (M8) is content-addressed and arch-agnostic — it stores
  whatever Kaniko pushes; no change beyond the arm64 bases above.

### A.4 gVisor binaries → arm64

Install the **arm64** `runsc` and `containerd-shim-runsc-v1` into `/usr/local/bin` (§4.2):
download the `aarch64` gVisor release, verify the `.sha512`, `install -m0755`. The
`RuntimeClass` manifest is unchanged.

### A.5 Cilium / kind → arm64 (mostly automatic)

Cilium and kind both publish arm64. The `m4-bootstrap.sh` images pull arm64 by manifest list.
The only open question is the **Cilium version pin** on the A1 kernel — see §5.1.

---

## 3. Infrastructure changes

Same as the KVM2 runbook (§3 there), with these swaps:

- **Terraform (`deploy/terraform/main.tf`)** — strip the GKE-specific resources exactly as
  the KVM2 runbook lists (remove `google_container_cluster`, `google_storage_bucket.reports`,
  the two `google_service_account`s; keep minimal Vault). The instance itself is created via
  the OCI console/`oci` CLI (§1.1), not `terraform apply`, since we are not standing up the
  full OCI provider for one box.
- **Report blobs → Cloudflare R2** — identical to KVM2 §3.2 (drop MinIO; point the S3 sink at
  the R2 endpoint). Unchanged by ARM.
- **Image pull (GHCR)** — identical to KVM2 §3.3: create a read-only PAT, `kubectl create
  secret docker-registry ghcr-pull …`. The pull secret is arch-agnostic; the manifest list
  from §A.1 does the arm64 selection.

---

## 4. Host preparation

### 4.1 Harness image from CI, not the box

Same principle as KVM2 §4.1 — no harness build ever runs on the VPS; only the untrusted
*target* builds in-cluster via Kaniko. The only delta: the CI image is now **multi-arch**
(§A.1). Confirm the GHCR harness **arm64** digest is current before H3.

### 4.2 One-time host prerequisites (Ubuntu 22.04 aarch64)

```bash
# 1. Confirm virtualization + kernel features
systemd-detect-virt            # expect a VM type (kvm/other); NOT a container
uname -m                       # expect: aarch64
ls /sys/kernel/btf/vmlinux     # must exist (Cilium BTF)

# 2. Clear OCI's injected host firewall rules (see §1.2) so Cilium/kube-proxy own the chains,
#    then persist. Keep egress OPEN. Do NOT add a host egress DROP.

# 3. Docker (daemon running, deploy user in the docker group)

# 4. CLIs the bootstrap checks for, on PATH (arm64 builds):
#    kind, kubectl, cilium, helm

# 5. gVisor arm64 binaries into /usr/local/bin (see §A.4):
#    download the aarch64 gvisor release, verify .sha512,
#    `sudo install -m0755` runsc and containerd-shim-runsc-v1
```

`scripts/m4-bootstrap.sh` fails fast if any of `docker kind kubectl cilium` or the two gVisor
binaries are missing.

### 4.3 Swapfile

Identical to KVM2 §4.3 — add a 6 GB swapfile on the boot volume as a Kaniko-spike safety net.
With 12 GB RAM the pressure is lower than on KVM2's 8 GB, but keep the swap; a large `FROM`
base can still spike.

```bash
sudo fallocate -l 6G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 5. Cluster bring-up (the M4 bootstrap, on the A1 box)

### 5.1 Cilium version — re-pin for the A1 kernel

`m4-bootstrap.sh` pins `CILIUM_VERSION=1.21.0-pre.2` to dodge a BPF-verifier bug on the
*development host's* Omarchy kernel (`m4-cilium-kernel-quirk`). The A1 box runs a **different
kernel (Ubuntu 22.04 aarch64)**, so:

1. First try the bootstrap default.
2. If `cilium status` is not healthy, try the current stable `1.21.x` (or latest stable) via
   `CILIUM_VERSION=<ver> ./scripts/m4-bootstrap.sh`.
3. Record whichever comes up clean on the **A1 aarch64** kernel as the **Oracle pin** (note it
   separately from the KVM2 pin — they may differ).

### 5.2 Stand up and smoke

```bash
cd /path/to/AutoSploit-AI
CILIUM_VERSION=<verified-ver> ./scripts/m4-bootstrap.sh --smoke
```

`--smoke` proves the M4 exit criterion on the box: a gVisor Pod schedules and runs under a
spoofed kernel, and a default-deny-egress NetworkPolicy bites. **Do not proceed to H3 until
`--smoke` is green on the A1 box.** If the smoke test shows odd connectivity, re-check the two
Oracle host-egress layers (§1.2) before suspecting anything else.

### 5.3 Deploy the control plane

Identical to KVM2 §5.3 — `ghcr-pull` secret, then `helm install control-plane …` with the R2
endpoint, Vault addr, and `OPENROUTER_API_KEY` wiring per `control-plane.md`. Secrets stay on
the trusted side per the invariant (`isolation-hardening-roadmap.md §6`): model key
conductor/harness-side only; GitHub token provisioner-side (clone only), never to the harness.

---

## 6. Resource budget (why it fits — now with more headroom)

Steady state, always-on, on **12 GB**:

| Component | ~RAM |
|---|---|
| Ubuntu host + Docker | 1.0 GB |
| kind node = k8s control plane | 2.0 GB |
| Cilium agent + operator + Envoy L7 proxy | 1.0 GB |
| Vault (minimal) | 0.25 GB |
| control-plane ingest (Helm) | 0.4 GB |
| **Steady total** | **~4.6 GB** |
| **Headroom for one engagement (12 GB box)** | **~7.4 GB** |

The extra 4 GB over KVM2 is the concrete benefit of this substrate: the single-engagement
burst (registry ~0.1 + Kaniko spike ~0.5–2 + target + attacker/harness ~0.5) fits with far
more slack, and the 6 GB swap (§4.3) still backs the Kaniko spike. Holds **only at
concurrency = 1** (§2) — the extra RAM is comfort, not a second engagement (2 OCPU is still
the wall).

---

## 7. H3 — the exit gate

Identical to KVM2 §7 — `scripts/redteam.sh` needs **no modification**, only a kubectl context
pointing at the A1 cluster.

### 7.1 Create the policed namespace

```bash
conductor run <a-small-arm64-dockerfile-repo> --k8s
```

Use a **small target whose `FROM` bases are arm64-published** (§A.3) for the first pass —
remember both the 2-OCPU Kaniko constraint and the arm64-only constraint. This creates
`engagement-<id>` with the CiliumNetworkPolicy applied fail-closed, before any Pod (§M7).

### 7.2 Run the red-team pass

```bash
./scripts/redteam.sh \
  --namespace engagement-<id> \
  --plane-ns default \
  --model-host api.openrouter.ai \
  --ingest-url http://control-plane:80/engagements/<id>/events
```

### 7.3 Exit criterion — what must be green

Unchanged from KVM2 §7.3:

- **SEAM-1 egress matrix.** From inside the engagement network, exactly three edges succeed —
  attacker → target, attacker → model API (`toFQDNs api.openrouter.ai:443`), attacker →
  control-plane `:80` — and the DENY set (arbitrary internet, plus ports 5432 / 6379 / 9092)
  has **zero** successes. Oracle's real egress (kept open per §1.2) is what lets the three M7
  assertions deferred on the air-gapped kind node finally run for real.
- **SEAM-2 secret split.** No GitHub token in logs or the harness; the model key never enters
  the plane/provisioner.

A green run is the exit-gate evidence. **This closes step 3** (isolation hardening). The
script fails loudly on any deviation — a red line is a real seam breach, not flake; fix the
seam, never loosen the test. **If a DENY edge unexpectedly *succeeds*, first rule out that an
Oracle VCN/host rule (§1.2) is bypassing the Cilium path** before touching the policy.

### 7.4 CI wiring (optional, after the first manual green)

Replace the `deploy-gke` job in `release.yml` with a `deploy-oci` job: SSH to the A1 box, run
the bootstrap + `helm install`, then `redteam.sh` over the remote context as the release gate.
Do the first H3 pass by hand; automate once reproducibly green.

---

## 8. When to reach for the hourly burst box

Not needed for H3. Same as KVM2 §8, with one extra ARM trigger:

- A target repo with a large multi-stage Dockerfile that Kaniko can't build in acceptable time
  on 2 cores.
- **A target whose base image has no `linux/arm64` variant** — it cannot build on A1 at all.
  Spin a temporary x86 hourly box for that engagement, or an arm64 burst box with more cores.
- Future concurrent engagements (the A1 does one at a time).

In each case: spin a temporary larger hourly VPS, run the same `m4-bootstrap.sh`, tear it down
after. Same substrate; the only new axis is arch (match the target's supported platforms).

---

## 9. Checklist

- [ ] A1 instance created (`VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 22.04 **aarch64**,
      ~100 GB boot). Retried through `Out of host capacity` if needed.
- [ ] Tenancy upgraded to **PAYG** to remove idle-reclaim risk.
- [ ] OCI VCN egress left **open**; only needed ingress added. Host `iptables` (OCI-injected)
      cleared so Cilium owns the chains; **no host egress DROP** (§1.2).
- [ ] `uname -m` = aarch64; `/sys/kernel/btf/vmlinux` exists.
- [ ] Docker + kind + kubectl + cilium + helm + **arm64** gVisor binaries installed.
- [ ] 6 GB swapfile added and in `/etc/fstab`.
- [ ] **Harness image multi-arch in GHCR incl. `linux/arm64`** (built by CI, not the box);
      arm64 digest confirmed; `ghcr-pull` secret created (§A.1).
- [ ] **Conductor / provisioner / Kaniko images arm64**; M5 mirror serves **arm64 bases**
      (§A.2, §A.3).
- [ ] `main.tf` stripped of GKE cluster + service accounts + GCS bucket; minimal Vault kept.
- [ ] Cloudflare R2 bucket + creds; reports sink pointed at R2.
- [ ] Cilium version verified on the **A1 aarch64** kernel; Oracle pin recorded (separate from
      the KVM2 pin).
- [ ] `m4-bootstrap.sh --smoke` green on the A1 box.
- [ ] Control plane deployed via Helm; secrets wired per the trust split.
- [ ] One engagement run under `--k8s` with a **small arm64-base** target; policed namespace
      exists.
- [ ] Concurrency held at 1.
- [ ] `redteam.sh` **green** — SEAM-1 + SEAM-2. **H3 closed, step 3 done.**
- [ ] (Optional) `deploy-oci` CI job replaces `deploy-gke`.
