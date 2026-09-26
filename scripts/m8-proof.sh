#!/usr/bin/env bash
#
# Roadmap M8 — live proof on kind: the in-cluster target build path, end to end.
#
#   registry Pod up  ->  Kaniko build (no docker socket, gVisor)  ->  push to the
#   per-engagement HTTP registry  ->  node containerd pulls the built image  ->
#   target Pod runs under gVisor and serves.
#
# Everything is rendered from the conductor's OWN manifest builders (the same code
# the --k8s path runs), so this proves the shipped manifests, not a hand-written
# twin. The build context is supplied from an in-cluster ConfigMap (dir:// context),
# not an external clone: under the M7 default-deny egress the build Pod cannot reach
# any external git host or base-image registry. That external-ingestion path is a
# tracked open item (roadmap §5 / M5 in-cluster mirror); this proof isolates the M8
# machinery and therefore runs the build WITHOUT the engagement NetworkPolicy.
#
# Node prerequisite (one-time, done by scripts/m4-bootstrap.sh step 4b): containerd
# `config_path = /etc/containerd/certs.d`. This script writes the per-engagement
# hosts.toml that maps the registry Service name -> http://<ClusterIP>:5000 so the
# node — which does NOT use coredns and rejects plain HTTP by default — can pull.
#
# Usage: ./scripts/m8-proof.sh [engagement-id]   (default: m8proof)
set -euo pipefail

ENG="${1:-m8proof}"
NODE="autosploit-hardening-control-plane"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${HERE}/conductor/.venv/bin/python"
NS="engagement-${ENG}"
CERTS_DIR="/etc/containerd/certs.d/registry.${NS}.svc:5000"

say() { echo "== $* =="; }
render() { "$PY" -c "import json,sys; from autosploit_conductor.k8s import manifests as m; print(json.dumps($1))"; }
apply()  { render "$1" | kubectl apply -f - ; }

kubectl config use-context kind-autosploit-hardening >/dev/null

cleanup() {
  say "teardown"
  kubectl delete namespace "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  docker exec "$NODE" rm -rf "$CERTS_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# --- 1. namespace + registry -------------------------------------------------
say "namespace + in-cluster registry (${NS})"
apply "m.namespace_manifest('${ENG}')"
apply "m.registry_pod_manifest('${ENG}')"
apply "m.registry_service_manifest('${ENG}')"
kubectl -n "$NS" wait --for=condition=Ready pod/registry --timeout=120s

# --- 2. in-cluster build context (dir:// ConfigMap, no external clone) --------
say "build-context ConfigMap (trivial Dockerfile; served in-cluster)"
kubectl -n "$NS" create configmap build-context --from-file=Dockerfile=/dev/stdin <<'DOCKERFILE'
FROM busybox:1.36
RUN echo 'm8-target-ok' > /index.html
EXPOSE 8080
CMD ["httpd","-f","-p","8080","-h","/"]
DOCKERFILE

# --- 3. Kaniko build -> push (gVisor, no docker socket) ----------------------
say "Kaniko build -> push to registry.${NS}.svc:5000"
apply "m.kaniko_build_pod_manifest('${ENG}', context='dir://'+m.BUILD_CONTEXT_MOUNT, destination=m.target_image_ref('${ENG}'), context_configmap='build-context')"
# Watch the build to a terminal phase (only Succeeded is a real build).
kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/build --timeout=600s \
  || { echo "build did not succeed; logs:"; kubectl -n "$NS" logs build | tail -30; exit 1; }
echo "-- build succeeded; last log lines:"; kubectl -n "$NS" logs build | tail -5

# --- 4. node pull mapping: registry Service name -> ClusterIP over HTTP -------
CLUSTER_IP="$(kubectl -n "$NS" get svc registry -o jsonpath='{.spec.clusterIP}')"
say "mapping node pull: registry.${NS}.svc:5000 -> http://${CLUSTER_IP}:5000 (certs.d)"
docker exec "$NODE" bash -c "
  set -e
  mkdir -p '${CERTS_DIR}'
  cat > '${CERTS_DIR}/hosts.toml' <<TOML
server = \"http://${CLUSTER_IP}:5000\"
[host.\"http://${CLUSTER_IP}:5000\"]
  capabilities = [\"pull\", \"resolve\"]
TOML
"
# certs.d is read per-pull; no containerd restart needed.

# --- 5. target Pod: pull the in-cluster-built image, run under gVisor ---------
say "target Pod from the built image (${NS}/target, gVisor)"
apply "m.target_pod_manifest('${ENG}', m.target_image_ref('${ENG}'), container_port=8080)"
apply "m.target_service_manifest('${ENG}', port=8080)"
kubectl -n "$NS" wait --for=condition=Ready pod/target --timeout=180s \
  || { echo "target not Ready; describe:"; kubectl -n "$NS" describe pod target | tail -30; exit 1; }

# --- 6. prove it serves ------------------------------------------------------
say "verify the target serves the in-cluster-built content"
kubectl -n "$NS" run probe --image=busybox:1.36 --restart=Never --command -- sleep 3600 >/dev/null
kubectl -n "$NS" wait --for=condition=Ready pod/probe --timeout=120s
BODY="$(kubectl -n "$NS" exec probe -- wget -qO- "http://target.${NS}.svc:8080/" || true)"
echo "-- GET target.${NS}.svc:8080 -> '${BODY}'"
echo -n "-- target kernel (gVisor spoof): "; kubectl -n "$NS" exec target -- uname -r 2>/dev/null || echo "(no shell in image)"

if [[ "$BODY" == "m8-target-ok" ]]; then
  say "M8 PROOF PASS: clone-free in-cluster build -> push -> node pull -> gVisor target served"
else
  echo "M8 PROOF FAIL: unexpected body"; exit 1
fi
