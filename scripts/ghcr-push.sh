#!/usr/bin/env bash
# Build and push the control-plane and harness images to GHCR so a fresh box can
# pull them instead of building locally (H3 Phase D/E "easier next time").
#
# This is the MANUAL route. The automated route is release.yml, which builds,
# scans, and pushes both images on a `v*` tag (or workflow_dispatch) — prefer it
# once the branch is merged and tagged. This script exists for when you want the
# images in GHCR without cutting a release (e.g. mid-branch on the Contabo box).
#
# Prereqs:
#   - docker logged in to GHCR:
#       echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
#     The PAT needs `write:packages` (and `read:packages` to pull). A classic PAT
#     or a fine-grained token with Packages: read&write both work.
#   - Run from the repo root.
#
# Usage:
#   scripts/ghcr-push.sh [--owner <ghcr-owner>] [--tag <tag>] [--only control-plane|harness]
#
# Defaults: owner=muditgarg007 (GHCR lowercases the GitHub owner), tag=the short
# git SHA. Images are pushed as:
#   ghcr.io/<owner>/control-plane:<tag>
#   ghcr.io/<owner>/harness:<tag>
#
# After pushing, the packages are PRIVATE by default. Either make them public in
# the GitHub UI (Packages -> package -> settings -> change visibility) or create a
# pull secret on the box (the script prints both the secret and the wiring).
set -euo pipefail

OWNER="muditgarg007"
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo latest)"
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --tag)   TAG="$2"; shift 2 ;;
    --only)  ONLY="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REG="ghcr.io/${OWNER}"
CP_IMAGE="${REG}/control-plane:${TAG}"
HARNESS_IMAGE="${REG}/harness:${TAG}"

build_push() {
  local name="$1" dockerfile="$2" context="$3" image="$4"
  echo ">> building ${name}: ${image}"
  docker build -f "${dockerfile}" -t "${image}" "${context}"
  echo ">> pushing ${image}"
  docker push "${image}"
}

if [[ "${ONLY}" != "harness" ]]; then
  build_push "control-plane" "control-plane/Dockerfile" "." "${CP_IMAGE}"
fi
if [[ "${ONLY}" != "control-plane" ]]; then
  build_push "harness" "harness/Dockerfile" "harness/" "${HARNESS_IMAGE}"
fi

cat <<EOF

================================================================================
Pushed to GHCR:
  control-plane : ${CP_IMAGE}
  harness       : ${HARNESS_IMAGE}

If the packages are PRIVATE, create a pull secret in autosploit-system and in
each engagement namespace that needs it:

  kubectl create secret docker-registry ghcr-pull -n autosploit-system \\
    --docker-server=ghcr.io --docker-username=<github-user> --docker-password=<GHCR_PAT>

Install / upgrade the control-plane from GHCR (drop the local-build overrides):

  helm upgrade --install control-plane deploy/helm/control-plane/ -n autosploit-system \\
    --set image.repository=${REG}/control-plane \\
    --set image.tag=${TAG} \\
    --set image.pullSecrets[0].name=ghcr-pull \\
    --set external.kafkaBrokers="" \\
    --set external.schemaRegistryUrl=""

Point the conductor at the GHCR harness image (Phase E):

  export AUTOSPLOIT_HARNESS_IMAGE=${HARNESS_IMAGE}   # or the @sha256 digest

To make the packages PUBLIC instead (no pull secret needed), change each
package's visibility to Public in the GitHub Packages UI, then install with
image.pullSecrets left empty.
================================================================================
EOF
