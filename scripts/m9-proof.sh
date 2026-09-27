#!/usr/bin/env bash
#
# Roadmap M9 — live proof on kind: the engagement workload as a real Helm release.
#
#   namespace + egress netpol (imperative)  ->  helm install the engagement chart
#   (nginx target, curl attacker, both under gVisor)  ->  attacker REACHES the
#   target through its Service  ->  attacker egress to the open internet is DENIED
#   by the M7 default-deny CiliumNetworkPolicy  ->  helm uninstall + namespace
#   delete leaves nothing behind.
#
# This is the milestone's exit criterion made live: the same chart the conductor's
# --k8s path installs (deploy/helm/engagement) is installed here as the release
# `engagement`, into a namespace the conductor's OWN manifest builders scaffold and
# lock down. The Namespace, the model-key Secret and the CiliumNetworkPolicy are
# applied imperatively BEFORE the release (they are deliberately not chart objects —
# see Chart.yaml): the namespace must exist to install into and egress must be
# default-deny before any untrusted Pod starts. The chart lands the workload inside
# that locked-down namespace.
#
# Stand-in images (nginx / curl) replace the real target/attacker so the proof
# isolates the M9 machinery (chart + release lifecycle + the egress boundary the
# workload runs inside), independent of the M8 in-cluster build. The attacker's
# entrypoint is overridden to `sleep` so we can exec probes into it; a real run
# takes the chart's default `run --config ...` args.
#
# Usage: ./scripts/m9-proof.sh [engagement-id]   (default: m9proof)
set -euo pipefail

ENG="${1:-m9proof}"
CLUSTER="autosploit-hardening"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${HERE}/conductor/.venv/bin/python"
CHART="${HERE}/deploy/helm/engagement"
NS="engagement-${ENG}"
RELEASE="engagement"          # matches k8s/run.py:_RELEASE_NAME
TARGET_IMAGE="nginx:alpine"
ATTACKER_IMAGE="curlimages/curl:8.10.1"

say()    { echo "== $* =="; }
render() { "$PY" -c "import json,sys; from autosploit_conductor.k8s import manifests as m; print(json.dumps($1))"; }
apply()  { render "$1" | kubectl apply -f - ; }

command -v helm >/dev/null || { echo "helm not on PATH — install helm to run this proof"; exit 1; }
kubectl config use-context "kind-${CLUSTER}" >/dev/null

cleanup() {
  say "teardown (helm uninstall + namespace delete)"
  helm -n "$NS" uninstall "$RELEASE" --wait --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete namespace "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- 1. namespace + egress netpol + model-key Secret (imperative, pre-release) ---
say "namespace + default-deny egress netpol + model-key Secret (${NS})"
apply "m.namespace_manifest('${ENG}')"
apply "m.network_policy_manifest('${ENG}')"
apply "m.secret_manifest('${ENG}', 'sk-proof-not-a-real-key')"

# --- 2. helm install the engagement chart as the release `engagement` ------------
say "helm install ${RELEASE} (chart=deploy/helm/engagement) into ${NS}"
helm install "$RELEASE" "$CHART" -n "$NS" \
  --set "engagementId=${ENG}" \
  --set "target.image=${TARGET_IMAGE}" \
  --set "target.port=80" \
  --set "attacker.image=${ATTACKER_IMAGE}" \
  --set 'attacker.command={sleep}' \
  --set-string 'attacker.args={3600}' \
  --wait --timeout 180s \
  || { echo "helm install failed; release status:"; helm -n "$NS" status "$RELEASE" || true; exit 1; }

echo "-- helm release:"; helm -n "$NS" list
kubectl -n "$NS" wait --for=condition=Ready pod/target   --timeout=180s \
  || { echo "target not Ready; describe:";   kubectl -n "$NS" describe pod target   | tail -30; exit 1; }
kubectl -n "$NS" wait --for=condition=Ready pod/attacker --timeout=180s \
  || { echo "attacker not Ready; describe:"; kubectl -n "$NS" describe pod attacker | tail -30; exit 1; }
echo -n "-- attacker kernel (gVisor spoof): "; kubectl -n "$NS" exec attacker -- uname -r 2>/dev/null || echo "(no uname)"

# --- 3. prove attacker -> target reachable (netpol rule 2: role=target) ----------
say "attacker -> target.${NS}.svc:80 (allowed by the egress netpol)"
REACH="$(kubectl -n "$NS" exec attacker -- \
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://target.${NS}.svc:80/" || true)"
echo "-- GET target.${NS}.svc:80 -> HTTP ${REACH}"

# --- 4. prove attacker -> open internet DENIED (default-deny egress, M7) ----------
# example.com resolves (DNS is allowed, L7 *) but is not in the toFQDNs allow-set,
# so the connection to it must never complete. A curl that hangs to timeout (exit
# 28) or otherwise fails is the pass; a 2xx/3xx would mean egress leaked.
say "attacker -> https://example.com (must be DENIED by default-deny egress)"
if kubectl -n "$NS" exec attacker -- curl -s -o /dev/null --max-time 8 "https://example.com/"; then
  EGRESS="REACHED"   # egress leaked — a fail
else
  EGRESS="BLOCKED"   # curl failed to complete (timeout/reset) — the pass
fi
echo "-- GET https://example.com -> ${EGRESS}"

# --- 5. verdict ------------------------------------------------------------------
if [[ "$REACH" == "200" && "$EGRESS" == "BLOCKED" ]]; then
  say "M9 PROOF PASS: chart installed as a Helm release; attacker reaches the target, open-internet egress denied"
else
  echo "M9 PROOF FAIL: reachability=${REACH} (want 200), egress=${EGRESS} (want BLOCKED)"; exit 1
fi
