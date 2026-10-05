# H3 on a Hostinger KVM2 VPS — Runbook

> **Status: ready to execute (2026-09-28).** This runbook closes the isolation-hardening
> exit gate (H3) on a **single Hostinger KVM2 VPS (2 vCPU / 8 GB RAM / ~100 GB NVMe)**.
> H3 = `scripts/redteam.sh` green against the real CiliumNetworkPolicy under live egress.
> It is the companion to `isolation-hardening-roadmap.md` (H3 milestone); the roadmap
> stays the authority for *why* each seam is shaped the way it is.

Running self-hosted is consistent with the settled isolation decision
(`deferred-open-items.md`: self-hosted K8s + gVisor, managed microVM rejected). GKE was
only the demo substrate. The application layers (conductor, harness, provisioner, the
`k8s/` controller) are substrate-agnostic and need **no code changes** — everything below
is infrastructure and operations.

---

## 1. What runs where

The expensive substrate — kind + Cilium + gVisor + Kaniko — **must** live on the VPS:
it needs a full KVM kernel, loadable modules, eBPF, and a custom `RuntimeClass`, none of
which a managed PaaS provides. Only two things move **off** the box, and only because they
are free and relieve real pressure:

| On the KVM2 VPS (always-on) | Off-box |
|---|---|
| kind node = k8s control plane | Harness image build → **GitHub Actions → GHCR** (§4.1) |
| Cilium CNI + Envoy L7 DNS proxy | Report blobs → **Cloudflare R2** (free, S3-protocol) (§3.2) |
| gVisor `RuntimeClass` | |
| Conductor (k8s controller, holds model key) | |
| Provisioner + **Kaniko target builds** (untrusted) | |
| Per-engagement target + attacker/harness Pods | |
| Control-plane ingest (`:80`, in-cluster) | |
| Per-engagement registry, minimal Vault | |

Hard rule: **nothing that holds a secret, ingests engagement traffic, or is a SEAM-1
egress edge leaves the VPS.** The CiliumNetworkPolicy inside the cluster is the SEAM-1
enforcement point — **keep the VPS host-level egress permissive**, or you mask the very
thing `redteam.sh` proves.

---

## 2. Constraints on KVM2 — read first

These bound everything below. They are not optional caveats; the plan only fits because
of them.

- **2 vCPU is the real bottleneck**, not RAM. gVisor, Cilium eBPF, and Kaniko all share 2
  cores. Builds are **slow but correct**. H3 itself is network-probe heavy with tiny Pods,
  so it runs comfortably; heavy target builds are the only thing that crawls.
- **One engagement at a time.** The RAM budget (§5) fits a single engagement burst. Keep
  the concurrency cap at **1** (already deferred as Q2 — do not raise it here).
- **Virtualization must be KVM, not OpenVZ.** Hostinger KVM2 is KVM ✓ (full kernel,
  loadable modules). OpenVZ cannot run kind/gVisor.
- **gVisor platform = `systrap`/`ptrace`.** The VPS is itself virtualized, so nested
  `/dev/kvm` is usually unavailable to `runsc`; it falls back to `systrap`, which needs no
  `/dev/kvm`. Works, just slower. Acceptable for the exit gate and MVP.
- **Kernel must expose eBPF + BTF** for Cilium. Ubuntu 20.04+ ships this. Verify
  `/sys/kernel/btf/vmlinux` exists (§4.2).
- **Heavy or parallel work needs a burst box, not this one.** If a target repo has a large
  multi-stage Dockerfile, or you later need concurrent engagements, spin a temporary
  larger hourly VPS with the same `m4-bootstrap.sh` and tear it down. Not required for H3.

---

## 3. Infrastructure changes

### 3.1 Terraform (`deploy/terraform/main.tf`)

Hostinger has no first-class Terraform provider, so the VM is provisioned out-of-band
(panel / cloud-init), not via `terraform apply`. Strip the GKE-specific resources:

| Resource | Action |
|----------|--------|
| `google_container_cluster.autosploit` (Autopilot) | **Remove.** Cluster is created by `m4-bootstrap.sh` on the VPS. Also removes the Autopilot gVisor/CRD restriction. |
| `google_storage_bucket.reports` | **Remove.** Replaced by Cloudflare R2 (§3.2). |
| `google_service_account.ghcr_pull` | **Remove.** Use a plain `imagePullSecret` (§3.3). |
| `google_service_account.plane` | **Remove.** No GCP workload identity on the VPS. |
| `vault_*` (transit engine, key, policy, k8s-auth role) | **Keep, minimal.** Run Vault as a small container on the VPS, or use the bootstrap transit engine for the demo. |

### 3.2 Report blobs → Cloudflare R2 (trim #2)

Drop local MinIO entirely — it costs RAM and needs persistent disk. Use R2 (free tier,
S3-protocol; Backblaze B2 is an equivalent fallback):

- Create an R2 bucket `autosploit-reports` and an access key / secret.
- Point the Reports sink / Kafka Connect S3 sink at the R2 endpoint
  (`https://<accountid>.r2.cloudflarestorage.com`) with those credentials.
- This is a config swap, not a code change — the sink is already S3-protocol.

### 3.3 Image pull (GHCR)

- Create a GHCR read-only PAT.
- `kubectl create secret docker-registry ghcr-pull --docker-server=ghcr.io \
  --docker-username=<user> --docker-password=<PAT>` in the control-plane namespace, and
  reference it where the GKE workload-identity pull used to be.

---

## 4. Host preparation

### 4.1 Harness image from CI, not the box (trim #1)

`.github/workflows/release.yml` already builds, scans, and pushes the **harness (attacker)
image** to GHCR. The VPS pulls it **by digest** (`AUTOSPLOIT_HARNESS_IMAGE`, commit
`d123fc0`) — no harness build ever runs on the VPS. Only the *untrusted target* repo
builds in-cluster via Kaniko (M8's whole point; that one cannot move off-box). Confirm the
GHCR harness digest is current before H3.

### 4.2 One-time host prerequisites

On the KVM2 (Ubuntu):

```bash
# 1. Confirm KVM + kernel features
systemd-detect-virt            # expect: kvm  (NOT openvz)
ls /sys/kernel/btf/vmlinux     # must exist (Cilium BTF)

# 2. Docker (daemon running, deploy user in the docker group)

# 3. CLIs the bootstrap checks for, on PATH:
#    kind, kubectl, cilium, helm

# 4. gVisor binaries into /usr/local/bin:
#    download gvisor.tar.bz2 for the arch, verify the .sha512,
#    `sudo install -m0755` runsc and containerd-shim-runsc-v1
```

`scripts/m4-bootstrap.sh` fails fast if any of `docker kind kubectl cilium` or the two
gVisor binaries are missing.

### 4.3 Swapfile (trim #3)

Add swap so a large `FROM` base in a Kaniko build cannot OOM-kill the kind node. This is a
spike safety net on NVMe, not steady use:

```bash
sudo fallocate -l 6G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 5. Cluster bring-up (the M4 bootstrap, on the VPS)

### 5.1 Cilium version — re-pin for the VPS kernel

`m4-bootstrap.sh` pins `CILIUM_VERSION=1.21.0-pre.2` to dodge a BPF-verifier bug on the
*development host's* Omarchy kernel (`m4-cilium-kernel-quirk`). The VPS runs a different
(Ubuntu) kernel, so:

1. First try the bootstrap default.
2. If `cilium status` is not healthy, try the current stable `1.21.x` (or latest stable)
   via `CILIUM_VERSION=<ver> ./scripts/m4-bootstrap.sh`.
3. Record whichever comes up clean on the VPS kernel as the VPS pin.

### 5.2 Stand up and smoke

```bash
cd /path/to/AutoSploit-AI
CILIUM_VERSION=<verified-ver> ./scripts/m4-bootstrap.sh --smoke
```

`--smoke` proves the M4 exit criterion on the VPS: a gVisor Pod schedules and runs under a
spoofed kernel, and a default-deny-egress NetworkPolicy bites. **Do not proceed to H3
until `--smoke` is green on the VPS.**

### 5.3 Deploy the control plane

```bash
kubectl create secret docker-registry ghcr-pull ...      # §3.3
helm install control-plane deploy/helm/control-plane/ \
  --set image.pullSecret=ghcr-pull \
  --set reports.s3.endpoint=https://<accountid>.r2.cloudflarestorage.com \
  # ...R2 creds, Vault addr, OPENROUTER_API_KEY wiring per control-plane.md
```

Secrets stay on the trusted side per the invariant (`isolation-hardening-roadmap.md §6`):
`OPENROUTER_API_KEY` conductor/harness-side only; the GitHub token provisioner-side
(clone only), never to the harness.

---

## 6. Resource budget (why it fits)

Steady state, always-on:

| Component | ~RAM |
|---|---|
| Ubuntu host + Docker | 1.0 GB |
| kind node = k8s control plane | 2.0 GB |
| Cilium agent + operator + Envoy L7 proxy | 1.0 GB |
| Vault (minimal) | 0.25 GB |
| control-plane ingest (Helm) | 0.4 GB |
| **Steady total** | **~4.6 GB** |
| **Headroom for one engagement** | **~3.4 GB** |

One serialized engagement (registry ~0.1 + Kaniko spike ~0.5–2 + target + attacker/harness
~0.5) fits the 3.4 GB headroom; the 6 GB swap (§4.3) covers the Kaniko spike. This holds
**only at concurrency = 1** (§2).

---

## 7. H3 — the exit gate

With the cluster up (§5) and the control plane deployed (§5.3), H3 is one green red-team
pass. `scripts/redteam.sh` needs **no modification** — only a kubectl context pointing at
the VPS cluster.

### 7.1 Run an engagement to create the policed namespace

```bash
conductor run <a-small-dockerfile-repo> --k8s
```

Use a **small** target Dockerfile for the first pass — remember the 2-vCPU Kaniko
constraint (§2). This creates `engagement-<id>` with the CiliumNetworkPolicy applied
fail-closed, before any Pod (§M7).

### 7.2 Run the red-team pass

```bash
./scripts/redteam.sh \
  --namespace engagement-<id> \
  --plane-ns default \
  --model-host api.openrouter.ai \
  --ingest-url http://control-plane:80/engagements/<id>/events
```

### 7.3 Exit criterion — what must be green

- **SEAM-1 egress matrix.** From inside the engagement network, exactly three edges
  succeed — attacker → target, attacker → model API (`toFQDNs api.openrouter.ai:443`),
  attacker → control-plane `:80` — and the DENY set (arbitrary internet, plus ports
  5432 / 6379 / 9092) has **zero** successes. The VPS's real egress is what lets the three
  M7 assertions deferred on the air-gapped kind node finally run for real.
- **SEAM-2 secret split.** No GitHub token in logs or the harness; the model key never
  enters the plane/provisioner.

A green run is the exit-gate evidence. **This closes step 3** (isolation hardening). The
script fails loudly on any deviation — a red line is a real seam breach, not flake; fix the
seam, never loosen the test.

### 7.4 CI wiring (optional, after the first manual green)

Replace the `deploy-gke` job in `release.yml` with a `deploy-vps` job: SSH to the KVM2, run
the bootstrap + `helm install`, then run `redteam.sh` over the remote context as the
release gate. Do the first H3 pass by hand; automate once reproducibly green.

---

## 8. When to reach for the hourly burst box

Not needed for H3. Spend the small hourly budget only where 2 vCPU genuinely hurts:

- A target repo with a large multi-stage Dockerfile that Kaniko can't build in acceptable
  time on 2 cores.
- Future concurrent engagements (the KVM2 does one at a time).

In both cases: spin a temporary larger hourly VPS, run the same `m4-bootstrap.sh`, tear it
down after. Same substrate, no new code.

---

## 9. Checklist

- [ ] KVM confirmed (`systemd-detect-virt` = kvm); `/sys/kernel/btf/vmlinux` exists.
- [ ] Docker + kind + kubectl + cilium + helm + gVisor binaries installed.
- [ ] 6 GB swapfile added and in `/etc/fstab`.
- [ ] `main.tf` stripped of GKE cluster + service accounts + GCS bucket; minimal Vault kept.
- [ ] Cloudflare R2 bucket + creds; reports sink pointed at R2.
- [ ] Harness image current in GHCR (built by CI, not the VPS); `ghcr-pull` secret created.
- [ ] Cilium version verified on the VPS kernel; VPS pin recorded.
- [ ] `m4-bootstrap.sh --smoke` green on the VPS.
- [ ] Control plane deployed via Helm; secrets wired per the trust split.
- [ ] One engagement run under `--k8s` (small Dockerfile); policed namespace exists.
- [ ] Concurrency held at 1.
- [ ] `redteam.sh` **green** — SEAM-1 + SEAM-2. **H3 closed, step 3 done.**
- [ ] (Optional) `deploy-vps` CI job replaces `deploy-gke`.
