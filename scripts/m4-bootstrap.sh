#!/usr/bin/env bash
#
# Roadmap M4 — local cluster substrate: kind + Cilium CNI + gVisor RuntimeClass.
# Idempotent-ish: safe to re-run; it recreates the cluster from scratch unless
# --keep is given. Exit criteria proven by --smoke: a gVisor Pod schedules and
# runs under a spoofed kernel, and a default-deny-egress NetworkPolicy bites.
#
# Prerequisites (host, one-time):
#   - docker (running, user in the docker group)
#   - kind, kubectl, cilium CLI, helm on PATH
#   - gVisor installed at /usr/local/bin/runsc and
#     /usr/local/bin/containerd-shim-runsc-v1  (download the release
#     gvisor.tar.bz2 for your arch, verify the .sha512, extract `runsc` and
#     `containerd-shim-runsc-v1`, `sudo install -m0755` both into /usr/local/bin).
#
# Usage:
#   ./scripts/m4-bootstrap.sh [--smoke] [--keep] [--delete]
#
set -euo pipefail

CLUSTER="autosploit-hardening"
NODE="${CLUSTER}-control-plane"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CFG="${HERE}/deploy/kind/hardening-cluster.yaml"

# Cilium: this kernel's BPF verifier rejects the FnSetRetval/CGroupSock helper
# probe in Cilium <=1.20.1 (fatal at agent start). 1.21.0-pre.2 carries the fix.
# Bump to the first stable 1.21.x once released.
CILIUM_VERSION="${CILIUM_VERSION:-1.21.0-pre.2}"

SMOKE=0; KEEP=0
for a in "$@"; do case "$a" in
  --smoke)  SMOKE=1 ;;
  --keep)   KEEP=1 ;;
  --delete) kind delete cluster --name "$CLUSTER"; exit 0 ;;
  -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
esac; done

say() { echo "== $* =="; }

for bin in docker kind kubectl cilium; do
  command -v "$bin" >/dev/null || { echo "missing prerequisite: $bin" >&2; exit 1; }
done
for f in /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; do
  [[ -x "$f" ]] || { echo "missing gVisor binary: $f (see header)" >&2; exit 1; }
done

# 1. Cluster (CNI off, gVisor binaries mounted into the node).
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  if [[ "$KEEP" -eq 0 ]]; then say "recreating cluster $CLUSTER"; kind delete cluster --name "$CLUSTER"; fi
fi
kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || {
  say "creating kind cluster $CLUSTER"; kind create cluster --config "$KIND_CFG"; }
kubectl config use-context "kind-${CLUSTER}" >/dev/null

# 2. Cilium CNI (socketLB off + legacy routing keeps us off the fragile BPF
#    cgroup-socket paths; kube-proxy stays in place for MVP).
say "installing Cilium ${CILIUM_VERSION}"
if ! helm ls -A 2>/dev/null | grep -qi '^cilium'; then
  cilium install --version "$CILIUM_VERSION" \
    --set socketLB.enabled=false \
    --set bpf.hostLegacyRouting=true \
    --set kubeProxyReplacement=false
fi
cilium status --wait --wait-duration 3m
kubectl wait --for=condition=Ready node --all --timeout=120s

# 3. Register the gVisor (runsc) containerd runtime in the node, then restart it.
say "registering runsc runtime in node containerd"
docker exec "$NODE" bash -c '
  set -e; CFG=/etc/containerd/config.toml
  if ! grep -q "runtimes.runsc\]" "$CFG"; then
    cp "$CFG" "$CFG.bak.$(date +%s)"
    printf "\n[plugins.\"io.containerd.grpc.v1.cri\".containerd.runtimes.runsc]\n  runtime_type = \"io.containerd.runsc.v1\"\n" >> "$CFG"
  fi
  systemctl restart containerd'
kubectl wait --for=condition=Ready node --all --timeout=120s

# 4. RuntimeClass mapping the k8s handler "gvisor" -> containerd runtime "runsc".
say "applying gvisor RuntimeClass"
kubectl apply -f - <<'YAML'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
YAML

say "M4 substrate ready"

# 5. Optional smoke: prove both exit criteria.
if [[ "$SMOKE" -eq 1 ]]; then
  say "smoke: gVisor pod + NetworkPolicy deny"
  kubectl create namespace m4-proof --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n m4-proof run gvisor-pod --image=busybox:1.36 \
    --overrides='{"spec":{"runtimeClassName":"gvisor"}}' --command -- sleep 3600 || true
  kubectl -n m4-proof wait --for=condition=Ready pod/gvisor-pod --timeout=90s
  echo "-- host kernel: $(uname -r)"
  echo -n "-- gvisor-pod kernel: "; kubectl -n m4-proof exec gvisor-pod -- uname -r
  DNS=$(kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}')
  echo -n "-- egress baseline to ${DNS}:53 -> "
  kubectl -n m4-proof exec gvisor-pod -- nc -z -w3 "$DNS" 53 && echo OPEN || echo blocked
  kubectl -n m4-proof apply -f - <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-egress, namespace: m4-proof }
spec: { podSelector: {}, policyTypes: [Egress] }
YAML
  sleep 3
  echo -n "-- egress after default-deny -> "
  kubectl -n m4-proof exec gvisor-pod -- nc -z -w4 "$DNS" 53 && echo "STILL OPEN (FAIL)" || echo "BLOCKED (pass)"
  echo "smoke done (namespace m4-proof left for inspection; 'kubectl delete ns m4-proof' to clear)"
fi
