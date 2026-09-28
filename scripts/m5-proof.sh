#!/usr/bin/env bash
#
# Roadmap M5 — live proof on kind: both M5 roles, under the live M7 egress.
#
#   Part A (harness image, digest-pull): build the attacker HARNESS image
#   (`docker build ./harness`, the same Dockerfile CI ships), load it into the
#   per-engagement in-cluster registry, capture its digest, then deploy the attacker
#   Pod BY DIGEST from the shipped Helm chart and prove the harness binary runs
#   (`autosploit-harness --help`, exit 0). GHCR digest-pull rides H3; the in-cluster
#   registry stands in for GHCR on the air-gapped kind cluster.
#
#   Part B (in-cluster repo/base mirror, under the LIVE M7 default-deny egress):
#   apply the engagement NetworkPolicy first, preload the external base into the
#   per-engagement registry (the conductor-side egress step), then run a Kaniko build
#   from a dir:// ConfigMap context + `--registry-mirror` and prove it SUCCEEDS with
#   no egress from the build Pod. Causation control: a sibling Kaniko Pod with a raw
#   git:// external context FAILS its clone under the same policy — proving egress is
#   still closed and the mirror, not a policy hole, is what let the build through.
#
# Everything cluster-side is rendered from the conductor's OWN manifest builders (the
# same code the --k8s path runs), so this proves the shipped manifests. Note:
# scripts/m8-proof.sh is stale post-M9 (renders the removed target_pod_manifest); this
# script routes around it and deploys the attacker from the Helm chart, not `manifests`.
#
# Getting images INTO the in-cluster registry: `kubectl port-forward` does not work
# against a gVisor Pod (runsc's own netstack is not reachable at the sandbox netns
# localhost the forwarder nsenters into), so the proof host cannot push over a
# forward. Instead the node's own containerd (`ctr`, which reaches the registry
# ClusterIP and speaks `--plain-http`) loads a `docker save` tarball and pushes it —
# no port-forward, no crane on the host, no daemon insecure-registry config. This is a
# proof-host stand-in for what the real system does with egress (CI push to GHCR in
# Part A; `mirror.mirror_base_image` via crane in Part B); the REGISTRY end-state is
# identical, which is what each part actually asserts. Images are built
# `--provenance=false --sbom=false` so `docker save` yields a single-manifest image
# `ctr` can import and push whole (a buildx attestation/index tarball is missing blobs
# on push).
#
# Node prerequisite (one-time, scripts/m4-bootstrap.sh step 4b): containerd
# `config_path = /etc/containerd/certs.d`. This script writes the per-engagement
# hosts.toml mapping the registry Service name -> http://<ClusterIP>:5000 so the node
# (which does not use coredns and rejects plain HTTP by default) can pull by digest.
#
# Usage: ./scripts/m5-proof.sh [engagement-id]   (default: m5proof)
set -euo pipefail

ENG="${1:-m5proof}"
CLUSTER="autosploit-hardening"
NODE="${CLUSTER}-control-plane"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${HERE}/conductor/.venv/bin/python"
CHART="${HERE}/deploy/helm/engagement"

# Distinct engagement ids -> distinct namespaces, so each part is isolated and the
# fixed Pod names (attacker/build) never clash across parts.
ENGA="${ENG}a"          # Part A: harness digest-pull
ENGB="${ENG}b"          # Part B: mirror build (positive)
ENGBN="${ENG}bn"        # Part B: git:// negative control
NSA="engagement-${ENGA}"
NSB="engagement-${ENGB}"
NSBN="engagement-${ENGBN}"
CERTS_A="/etc/containerd/certs.d/registry.${NSA}.svc:5000"
HARNESS_TAG="autosploit-harness:${ENG}"
BASE_TAG="m5base-${ENG}:latest"

say()    { echo; echo "== $* =="; }
render() { "$PY" -c "import json; from autosploit_conductor.k8s import manifests as m; print(json.dumps($1))"; }
apply()  { render "$1" | kubectl apply -f - ; }

command -v helm   >/dev/null || { echo "helm not on PATH — install helm to run this proof"; exit 1; }
command -v docker >/dev/null || { echo "docker not on PATH — needed to build the images"; exit 1; }
kubectl config use-context "kind-${CLUSTER}" >/dev/null

cleanup() {
  say "teardown"
  helm -n "$NSA" uninstall attacker --wait --ignore-not-found >/dev/null 2>&1 || true
  for ns in "$NSA" "$NSB" "$NSBN"; do
    kubectl delete namespace "$ns" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  docker exec "$NODE" rm -rf "$CERTS_A" /img.tar 2>/dev/null || true
  docker rmi "$HARNESS_TAG" "$BASE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Load a local docker image into the per-engagement registry via the node's ctr
# (reaches the ClusterIP, plain HTTP). `localtag` must be a `name:tag` present in the
# host docker; `repo` is the destination repository[:tag] inside the registry.
load_into_registry() {
  local ns="$1" localtag="$2" repo="$3" ip tar
  ip="$(kubectl -n "$ns" get svc registry -o jsonpath='{.spec.clusterIP}')"
  tar="$(mktemp --suffix=.tar)"
  docker save "$localtag" -o "$tar"
  docker cp "$tar" "$NODE:/img.tar" >/dev/null
  rm -f "$tar"
  docker exec "$NODE" ctr -n k8s.io images import /img.tar >/dev/null
  docker exec "$NODE" ctr -n k8s.io images tag --force "docker.io/library/${localtag}" "${ip}:5000/${repo}" >/dev/null
  docker exec "$NODE" ctr -n k8s.io images push --plain-http "${ip}:5000/${repo}" >/dev/null 2>&1
  # Drop the node-local image records so a later Pod ref by the registry's Service DNS
  # name is unknown to containerd and MUST resolve through the registry (via certs.d),
  # not short-circuit off these load-time entries — i.e. a genuine registry pull.
  docker exec "$NODE" ctr -n k8s.io images rm "docker.io/library/${localtag}" "${ip}:5000/${repo}" >/dev/null 2>&1 || true
  docker exec "$NODE" rm -f /img.tar
}

# The manifest digest the registry stored for <repo>:latest (Docker-Content-Digest).
registry_digest() {
  local ns="$1" repo="$2" ip
  ip="$(kubectl -n "$ns" get svc registry -o jsonpath='{.spec.clusterIP}')"
  docker exec "$NODE" bash -c "curl -sI \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json' \
    http://${ip}:5000/v2/${repo}/manifests/latest | tr -d '\r' | awk '/[Dd]ocker-[Cc]ontent-[Dd]igest/{print \$2}'"
}

# Map the registry Service name -> http://<ClusterIP>:5000 in the node's certs.d so
# containerd can pull the in-cluster-hosted image over plain HTTP (mirrors m8 step 4).
map_node_pull() {
  local ns="$1" certs="$2" ip
  ip="$(kubectl -n "$ns" get svc registry -o jsonpath='{.spec.clusterIP}')"
  docker exec "$NODE" bash -c "
    set -e
    mkdir -p '${certs}'
    cat > '${certs}/hosts.toml' <<TOML
server = \"http://${ip}:5000\"
[host.\"http://${ip}:5000\"]
  capabilities = [\"pull\", \"resolve\"]
TOML
  "
}

# =============================================================================
# Part A — harness image built, loaded, and pulled BY DIGEST from the chart
# =============================================================================
say "PART A: namespace + registry + model-key Secret (${NSA})"
apply "m.namespace_manifest('${ENGA}')"
apply "m.registry_pod_manifest('${ENGA}')"
apply "m.registry_service_manifest('${ENGA}')"
apply "m.secret_manifest('${ENGA}', 'sk-proof-not-a-real-key')"
kubectl -n "$NSA" wait --for=condition=Ready pod/registry --timeout=120s

say "build the harness image (docker build ./harness)"
docker build --provenance=false --sbom=false -t "$HARNESS_TAG" "${HERE}/harness"

say "load the harness into registry.${NSA}.svc:5000 and capture its digest"
load_into_registry "$NSA" "$HARNESS_TAG" "harness:latest"
DIGEST="$(registry_digest "$NSA" harness)"
[[ "$DIGEST" == sha256:* ]] || { echo "failed to capture pushed digest (got '${DIGEST}')"; exit 1; }
IMAGE_REF="registry.${NSA}.svc:5000/harness@${DIGEST}"
echo "-- harness digest ref: ${IMAGE_REF}"

say "map node pull for registry.${NSA}.svc:5000 (certs.d)"
map_node_pull "$NSA" "$CERTS_A"

say "helm install the attacker BY DIGEST (chart=deploy/helm/engagement)"
# No --wait: the attacker runs `autosploit-harness --help`, exits 0, and reaches Pod
# phase Succeeded (never Ready), which is exactly the pass. The target is an inert
# stand-in (we assert only on the attacker). No model key is exercised by --help.
helm install attacker "$CHART" -n "$NSA" \
  --set "engagementId=${ENGA}" \
  --set "target.image=nginx:alpine" \
  --set "target.port=80" \
  --set "attacker.image=${IMAGE_REF}" \
  --set 'attacker.command={autosploit-harness}' \
  --set-string 'attacker.args={--help}' \
  || { echo "helm install failed"; helm -n "$NSA" status attacker || true; exit 1; }

say "attacker Pod pulls by digest and the harness runs (want phase=Succeeded)"
if kubectl -n "$NSA" wait --for=jsonpath='{.status.phase}'=Succeeded pod/attacker --timeout=240s; then
  PARTA="PASS"
else
  PARTA="FAIL"
  echo "-- attacker did not Succeed; describe + logs:"
  kubectl -n "$NSA" describe pod attacker | tail -30
fi
echo "-- attacker logs (harness --help):"; kubectl -n "$NSA" logs attacker 2>/dev/null | head -15 || true

# =============================================================================
# Part B — mirror build SUCCEEDS under live egress; git:// control FAILS
# =============================================================================
say "PART B: namespace + registry + LIVE default-deny egress netpol (${NSB})"
apply "m.namespace_manifest('${ENGB}')"
apply "m.network_policy_manifest('${ENGB}')"
apply "m.registry_pod_manifest('${ENGB}')"
apply "m.registry_service_manifest('${ENGB}')"
kubectl -n "$NSB" wait --for=condition=Ready pod/registry --timeout=120s

say "preload the base into the mirror: busybox:1.36 -> registry.${NSB}.svc:5000/library/busybox:1.36"
# Conductor-side egress step (real path: mirror.mirror_base_image via crane). Built
# provenance-free so `docker save`/`ctr` handle it whole. Kaniko's --registry-mirror
# resolves `FROM busybox:1.36` to <mirror>/library/busybox:1.36, so the base must land
# at exactly that repo path (provision._mirror_dst).
printf 'FROM busybox:1.36\n' | docker build --provenance=false --sbom=false -t "$BASE_TAG" - >/dev/null
load_into_registry "$NSB" "$BASE_TAG" "library/busybox:1.36"

say "build-context ConfigMap (dir:// context; FROM the mirrored base)"
# A flat repo (Dockerfile only) — a ConfigMap key cannot contain '/', so this is the
# single-file MVP shape the mirror path packs; a nested repo rides the deferred
# git-mirror Pod. Rendered from the shipped build_context_configmap_manifest builder.
render "m.build_context_configmap_manifest('${ENGB}', {'Dockerfile': 'FROM busybox:1.36\nRUN echo m5-mirror-build-ok > /index.html\nCMD [\"httpd\",\"-f\",\"-p\",\"8080\",\"-h\",\"/\"]\n'})" \
  | kubectl -n "$NSB" apply -f -

say "Kaniko build under the live egress: dir:// context + --registry-mirror (want Succeeded)"
apply "m.kaniko_build_pod_manifest('${ENGB}', context='dir://'+m.BUILD_CONTEXT_MOUNT, destination=m.target_image_ref('${ENGB}'), context_configmap=m.BUILD_CONTEXT_CONFIGMAP, registry_mirror=m.registry_mirror_endpoint('${ENGB}'))"
if kubectl -n "$NSB" wait --for=jsonpath='{.status.phase}'=Succeeded pod/build --timeout=600s; then
  PARTB_POS="PASS"
else
  PARTB_POS="FAIL"
  echo "-- mirror build did not Succeed; logs:"; kubectl -n "$NSB" logs build | tail -30
fi
echo "-- build log tail:"; kubectl -n "$NSB" logs build 2>/dev/null | tail -5 || true

say "CONTROL: sibling git:// build under the SAME egress must FAIL its clone (${NSBN})"
apply "m.namespace_manifest('${ENGBN}')"
apply "m.network_policy_manifest('${ENGBN}')"
# Raw external git context — no mirror, no dir:// ConfigMap. Under default-deny egress
# the clone can reach no git host, so the build must NOT Succeed. Proves the egress is
# genuinely closed and Part B's success came from the mirror, not a policy hole.
apply "m.kaniko_build_pod_manifest('${ENGBN}', context='git://github.com/octocat/Hello-World.git#refs/heads/master', destination=m.target_image_ref('${ENGBN}'))"
# Any non-Succeeded terminal state is the pass; time-box the wait, then read the phase.
kubectl -n "$NSBN" wait --for=jsonpath='{.status.phase}'=Succeeded pod/build --timeout=120s >/dev/null 2>&1 || true
CTRL_PHASE="$(kubectl -n "$NSBN" get pod build -o jsonpath='{.status.phase}' 2>/dev/null || echo Unknown)"
if [[ "$CTRL_PHASE" != "Succeeded" ]]; then PARTB_CTRL="PASS"; else PARTB_CTRL="FAIL"; fi
echo "-- git:// control phase: ${CTRL_PHASE} (want NOT Succeeded)"

# =============================================================================
# Verdict
# =============================================================================
say "VERDICT"
echo "  Part A  (harness digest-pull + run):         ${PARTA}"
echo "  Part B  (mirror build under live egress):    ${PARTB_POS}"
echo "  Part B  (git:// control fails, egress shut): ${PARTB_CTRL}"
if [[ "$PARTA" == "PASS" && "$PARTB_POS" == "PASS" && "$PARTB_CTRL" == "PASS" ]]; then
  say "M5 PROOF PASS: harness pulled by digest + ran; mirror build succeeded under live egress; git:// egress still denied"
else
  echo "M5 PROOF FAIL"; exit 1
fi
