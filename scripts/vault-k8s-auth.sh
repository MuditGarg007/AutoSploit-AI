#!/usr/bin/env bash
# Wire the dev Vault's Kubernetes auth method so the control-plane pod authenticates
# with its own ServiceAccount token (Path B, docs/control-plane.md §9.1) instead of
# the static VAULT_TOKEN. This silences the recurring
#   warn  VaultService  k8s Vault auth failed, falling back to VAULT_TOKEN
# and exercises the production auth path. VaultService.authToken() calls
#   kubernetesLogin({ role: 'control-plane', jwt: <pod SA token> })
# so the Vault role MUST be named exactly "control-plane".
#
# Run this ON THE VPS (root@169.58.86.230), where kubectl and the vault pod live:
#   bash scripts/vault-k8s-auth.sh
# Idempotent: enabling an already-enabled method, re-writing the policy, and
# re-writing the role are all safe to repeat.
#
# IMPORTANT — dev Vault caveat: the box runs `vault server -dev`, whose storage
# (Transit key, auth config, policies) is IN-MEMORY and is LOST on every vault pod
# restart. After any restart, re-create the transit key AND re-run this script.
# This wiring proves and uses Path B; it does not make a dev Vault durable. For a
# durable deployment, back Vault with raft/file storage (see the handoff doc).
#
# VAULT_TOKEN is deliberately left in control-plane-secrets as a fallback: the code
# tries k8s auth first and only falls back if it fails, so keeping the token costs
# nothing and avoids a hard outage if the auth method is wiped by a restart.
set -euo pipefail

NS="${NS:-autosploit-system}"
VAULT_LABEL="${VAULT_LABEL:-app=vault}"     # label selecting the vault pod
TRANSIT_KEY="${TRANSIT_KEY:-github-tokens}" # must match VAULT_TRANSIT_KEY
ROLE="${ROLE:-control-plane}"               # must match vault.service.ts role
POLICY="${POLICY:-github-tokens-rw}"
TTL="${TTL:-1h}"
RBAC_FILE="${RBAC_FILE:-$(dirname "$0")/../deploy/vault/vault-auth-delegator-rbac.yaml}"
POLICY_FILE="${POLICY_FILE:-$(dirname "$0")/../deploy/vault/transit-github-tokens.hcl}"

echo "== discovering pods in namespace $NS =="
VAULT_POD="$(kubectl -n "$NS" get pod -l "$VAULT_LABEL" -o jsonpath='{.items[0].metadata.name}')"
VAULT_SA="$(kubectl -n "$NS" get pod "$VAULT_POD" -o jsonpath='{.spec.serviceAccountName}')"
VAULT_SA="${VAULT_SA:-default}"
# The control-plane app pod's ServiceAccount — the identity the Vault role binds to.
APP_SA="$(kubectl -n "$NS" get pod -l app=control-plane \
  -o jsonpath='{.items[0].spec.serviceAccountName}')"
echo "   vault pod : $VAULT_POD (SA: $VAULT_SA)"
echo "   app SA    : $APP_SA"
echo "   namespace : $NS   role: $ROLE   policy: $POLICY   transit key: $TRANSIT_KEY"

echo "== [1/5] grant the vault SA system:auth-delegator (TokenReview) =="
# Apply the committed binding, patched to the discovered vault SA so it is correct
# even when that SA is not the manifest's default.
kubectl create clusterrolebinding vault-auth-delegator \
  --clusterrole=system:auth-delegator \
  --serviceaccount="${NS}:${VAULT_SA}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Resolve the dev root token for in-pod vault CLI calls (from the vault-dev Secret,
# falling back to the pod's VAULT_DEV_ROOT_TOKEN_ID env).
VTOKEN="$(kubectl -n "$NS" get secret vault-dev \
  -o jsonpath='{.data.VAULT_DEV_ROOT_TOKEN_ID}' 2>/dev/null | base64 -d || true)"
if [ -z "$VTOKEN" ]; then
  VTOKEN="$(kubectl -n "$NS" exec "$VAULT_POD" -- \
    sh -c 'printf %s "$VAULT_DEV_ROOT_TOKEN_ID"')"
fi

# Helper: run a vault CLI command inside the vault pod, authenticated as root.
vx() { kubectl -n "$NS" exec -i "$VAULT_POD" -- \
  sh -c "VAULT_TOKEN='$VTOKEN' VAULT_ADDR=http://127.0.0.1:8200 vault $*"; }

echo "== [2/5] ensure Transit engine + key '$TRANSIT_KEY' exist =="
vx secrets enable transit 2>/dev/null || echo "   transit already enabled"
vx write -f "transit/keys/${TRANSIT_KEY}" >/dev/null && echo "   key ensured"

echo "== [3/5] enable the Kubernetes auth method =="
vx auth enable kubernetes 2>/dev/null || echo "   kubernetes auth already enabled"

echo "== [4/5] configure k8s auth (local token review via the vault SA) + policy =="
# kubernetes_host from inside the pod; CA + reviewer JWT default to the pod's
# mounted SA (disable_local_ca_jwt defaults false), which is why step 1's binding
# is required.
vx write auth/kubernetes/config \
  kubernetes_host="https://\$KUBERNETES_SERVICE_HOST:\$KUBERNETES_SERVICE_PORT" >/dev/null
# Write the least-privilege policy by piping the committed HCL into the pod.
kubectl -n "$NS" exec -i "$VAULT_POD" -- \
  sh -c "VAULT_TOKEN='$VTOKEN' VAULT_ADDR=http://127.0.0.1:8200 vault policy write ${POLICY} -" \
  < "$POLICY_FILE"
echo "   policy '$POLICY' written"

echo "== [5/5] bind role '$ROLE' to SA '$APP_SA' in '$NS' =="
vx write "auth/kubernetes/role/${ROLE}" \
  bound_service_account_names="${APP_SA}" \
  bound_service_account_namespaces="${NS}" \
  policies="${POLICY}" \
  ttl="${TTL}" >/dev/null
echo "   role bound"

echo "== restart the app so it re-attempts k8s auth =="
kubectl -n "$NS" rollout restart deploy/control-plane-control-plane-app
kubectl -n "$NS" rollout status  deploy/control-plane-control-plane-app --timeout=120s

echo "== verify: expect NO 'k8s Vault auth failed' in the new pod's logs =="
sleep 3
if kubectl -n "$NS" logs -l app=control-plane --tail=100 \
   | grep -q "k8s Vault auth failed"; then
  echo "!! still falling back to VAULT_TOKEN — check role name, SA binding, and the"
  echo "   auth-delegator ClusterRoleBinding (RBAC_FILE=$RBAC_FILE)."
  exit 1
fi
echo "OK: control-plane authenticated to Vault via its ServiceAccount (Path B)."
