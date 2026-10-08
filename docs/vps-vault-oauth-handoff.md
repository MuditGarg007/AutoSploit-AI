# VPS Vault gap — GitHub OAuth callback returns 500 (handoff)

**Date:** 2026-10-08
**Box:** Contabo `root@169.58.86.230`, kind cluster `autosploit-hardening`, namespace `autosploit-system`
**Public API:** `https://api.autosploit.muditgarg.xyz`
**Frontend:** `https://autosploit.muditgarg.xyz`
**Predecessors:** `docs/vps-backend-deploy-handoff.md`, `docs/vps-backend-public-exposure.md`,
`docs/vps-ghcr-image-fix-handoff.md`

## RESOLVED 2026-10-08 (Path A)

Dev-mode Vault stood up in-cluster; login encryption path is live. What was done:

- Deployed `vault` (image `hashicorp/vault:1.17`, `server -dev`) as Deployment +
  Service on `:8200` in `autosploit-system`. Manifest: `deploy/` equivalent lives at
  `/root/vault-dev.yaml` on the VPS (dev root token from Secret `vault-dev`, generated
  on-box, never committed). No NetworkPolicy exists in the namespace, so the M7 egress
  worry below did not apply.
- Enabled Transit and created key `github-tokens` (matches `VAULT_TRANSIT_KEY`).
- Wired `VAULT_TOKEN` into `control-plane-secrets` (copied from `vault-dev`).
- **Chart fix (committed to the repo):** `app-deployment.yaml` now maps a `VAULT_TOKEN`
  env from the secret with `optional: true` (absent in prod, present for this dev path).
  Shipped to the VPS and applied via `helm upgrade` (release rev 7).

Verification: new pod boots with **no** `EAI_AGAIN vault` and **no** transit-key warning;
a live `transit/encrypt` + `transit/decrypt` round-trip from inside the app pod, using the
pod's own `VAULT_TOKEN`/`VAULT_ADDR`/`VAULT_TRANSIT_KEY`, returned HTTP 200, a `vault:v1:`
ciphertext, and a matching decrypt. The browser 302→dashboard leg was not re-run here (no
Chrome available in the session) but encryption was the only remaining break.

**Follow-up / gotcha for the durable Path B:** `VaultService.authToken()` (the k8s-auth
method, `vault.service.ts:33`) is **dead code** — it is never called. `encrypt`/`decrypt`
use the constructor-time `this.client`, whose token is `env.vaultToken` (static
`VAULT_TOKEN`). So Path B as written below (pure k8s auth, no `VAULT_TOKEN`) **will not
work** until `encrypt`/`decrypt` are changed to authenticate per-call via `authToken()`.
Plan that code change before attempting Path B.

## TL;DR

The GitHub OAuth login now gets all the way through GitHub and back to the backend
`/auth/callback`, but the callback returns **HTTP 500** because it tries to encrypt the
user's GitHub token with **HashiCorp Vault (Transit engine)** and **no Vault is deployed
in the cluster**. `VaultService` has no dev/no-op fallback, so a reachable Vault is a hard
requirement for login to complete. This handoff is to stand up a Vault that satisfies that
requirement and finish the end-to-end login test.

This is a separate, downstream blocker from the earlier fix (the OAuth app `client_id` was
a placeholder causing a GitHub 404 — now resolved; see "What already works" below).

## What already works (do not re-debug)

An end-to-end run on 2026-10-08 confirmed everything up to the token-encryption step:

1. `https://autosploit.muditgarg.xyz/login` renders; "Continue with GitHub" navigates to
   `https://api.autosploit.muditgarg.xyz/auth/github`.
2. The backend redirects to `https://github.com/login/oauth/authorize` with a **real**
   `client_id` (OAuth App "Autosploit by Mudit Garg"), `redirect_uri=.../auth/callback`,
   `scope=repo`, and a state cookie. No more GitHub 404.
3. GitHub shows the consent screen and, on Authorize, redirects to
   `https://api.autosploit.muditgarg.xyz/auth/callback?code=...&state=...`.
4. The backend validates state, exchanges the code for the user's GitHub token, and fetches
   the GitHub profile — all successful.
5. It then calls `IdentityService.completeGitHubLogin`, which calls `VaultService.encrypt`
   to encrypt the token before persisting it. **This is where it fails.**

So: OAuth config, the authorize redirect, the state/CSRF check, the code→token exchange, and
the profile fetch are all healthy. Only the Vault-backed encryption step is broken.

## Evidence

Browser: the callback page shows
```json
{"statusCode":500,"message":"Internal server error"}
```

Pod logs (`kubectl logs -n autosploit-system deploy/control-plane-control-plane-app`):
```
warn  VaultService  Vault Transit key "github-tokens" not created: unknown error.
      In prod this is provisioned by Terraform; ensure it exists before use.
error ExceptionsHandler  getaddrinfo EAI_AGAIN vault
      at VaultService.encrypt (.../identity/vault/vault.service.js:74)
      at IdentityService.completeGitHubLogin (.../identity/identity.service.js:38)
      at IdentityController.callback (.../identity/identity.controller.js:57)
```

`getaddrinfo EAI_AGAIN vault` = DNS cannot resolve the host `vault`. The app is configured
with `VAULT_ADDR=http://vault:8200`, but there is no `vault` Service or pod in any namespace:
```
kubectl get svc,pods -A | grep -i vault   # → nothing
```

## Relevant code + config (for context)

- `control-plane/src/domains/identity/vault/vault.service.ts` — the Vault client. Key points:
  - Transit engine; stores only `vault:v1:`-prefixed ciphertext, never the key.
  - `onModuleInit` calls `transitCreateKey({ name: vaultTransitKey })`; treats HTTP 204
    (already exists) as success, warns otherwise. It does **not** throw on failure, so the
    app still boots without Vault — the failure only surfaces at the first `encrypt`.
  - Auth: if `KUBERNETES_SERVICE_HOST` is set (it is, in-cluster), it first tries
    `kubernetesLogin({ role: 'control-plane', jwt: <SA token> })`. On failure it logs
    `k8s Vault auth failed, falling back to VAULT_TOKEN` and uses `env.vaultToken`.
  - **No local/dev/no-op fallback for encrypt/decrypt** — a live Vault is required.
- `control-plane/src/config/env.service.ts`:
  - `vaultAddr = VAULT_ADDR ?? 'http://localhost:8200'`
  - `vaultToken = VAULT_TOKEN ?? VAULT_DEV_ROOT_TOKEN_ID ?? ''`
  - `vaultTransitKey = required('VAULT_TRANSIT_KEY')` — currently the secret value is
    `github-tokens` (per the log line above).
- `deploy/helm/control-plane/values.yaml`:
  - `external.vaultAddr: http://vault:8200`
  - `serviceAccount` is annotated for Vault k8s auth; the design intent (§9.1 of
    `docs/control-plane.md`) is that Terraform provisions the Transit key and wires Vault's
    k8s auth method to the `control-plane` role, so there is no static bootstrap token.
- Secret `control-plane-secrets` (namespace `autosploit-system`) currently holds these keys:
  `GITHUB_CALLBACK_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `INGEST_TOKEN_SIGNING_KEY`,
  `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `VAULT_TRANSIT_KEY`. There is **no** `VAULT_TOKEN`
  key yet.

## The fix — pick one path

### Path A — Dev-mode Vault in-cluster (fast, unblocks the e2e test)

Goal: a `vault` Deployment + Service on `:8200` running in dev mode, Transit enabled, key
`github-tokens` created, and the app pointed at it via `VAULT_TOKEN` (the pod's k8s-auth
attempt will fail and fall back to this token — that is expected and fine for dev).

Trade-offs: dev mode is **in-memory** — all encrypted GitHub tokens are lost if the Vault
pod restarts, and the root token is dev-grade. Acceptable for a functional login test, not
for durable production use.

Suggested steps (verify image/flags against the current environment before applying):

1. Choose a dev root token, e.g. `VAULT_DEV_ROOT_TOKEN_ID=root-dev-<random>`.
2. Deploy Vault dev-mode as Deployment `vault` + Service `vault` (`:8200 → 8200`) in
   `autosploit-system`. The official `hashicorp/vault` image in `server -dev` mode works;
   set `VAULT_DEV_ROOT_TOKEN_ID` and `VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200`. The Service
   name **must** be `vault` so it resolves `http://vault:8200` (matches `VAULT_ADDR`).
   - Note: the cluster is network-policy fail-closed (M7). Add/adjust a NetworkPolicy so the
     control-plane pod can reach the `vault` pod on `:8200` in-namespace, or the call will
     time out instead of 500. Verify with the egress policies already in the namespace.
3. Enable the Transit engine and create the key (one-off, e.g. `kubectl exec` into the vault
   pod): `vault secrets enable transit` then `vault write -f transit/keys/github-tokens`.
   (`onModuleInit` also tries to create the key, but only if it can authenticate — doing it
   explicitly removes that dependency.)
4. Put the dev token in the app secret and restart:
   ```bash
   kubectl patch secret control-plane-secrets -n autosploit-system \
     --type merge -p '{"stringData":{"VAULT_TOKEN":"<dev-root-token>"}}'
   kubectl rollout restart deploy/control-plane-control-plane-app -n autosploit-system
   ```
   The deployment must also expose `VAULT_TOKEN` to the container — confirm
   `deploy/helm/control-plane/templates/app-deployment.yaml` maps a `VAULT_TOKEN` env from
   the secret; if not, add it (there is currently no `VAULT_TOKEN` env wired — check before
   assuming the patch alone is enough).

### Path B — Persistent Vault with k8s auth (matches the §9.1 design)

Goal: Vault with real storage (so tokens survive restarts) and the **k8s auth method** wired
to the `control-plane` role, so `VaultService.authToken()` succeeds with the pod's
service-account token and **no `VAULT_TOKEN` is needed**. This is the design in
`docs/control-plane.md` §9.1 / §8.2 (normally Terraform-provisioned).

Outline (more setup; do it if this VPS is meant to be durable):
1. Deploy Vault with a persistent storage backend (file or integrated raft), unsealed and
   initialised (store the unseal keys / root token out-of-band — do not commit them).
2. Enable Transit, create key `github-tokens`.
3. Enable the Kubernetes auth method; create policy allowing `transit/encrypt/github-tokens`
   and `transit/decrypt/github-tokens`; bind a role named **`control-plane`** to the app's
   ServiceAccount + namespace (the role name is hard-coded in `vault.service.ts`).
4. Leave `VAULT_ADDR=http://vault:8200`; do **not** set `VAULT_TOKEN` (force the k8s-auth
   path). Restart the deployment.

## Verification (either path)

1. App healthy and reaching Vault:
   ```bash
   kubectl logs -n autosploit-system deploy/control-plane-control-plane-app --tail=50 \
     | grep -i vault          # expect NO "EAI_AGAIN vault" and NO transit-key warning
   ```
2. Re-run the browser login (or just the callback leg) and confirm the final redirect is
   `https://autosploit.muditgarg.xyz/dashboard?access_token=...` (HTTP 302 from the backend),
   not a 500 JSON body.
3. Confirm the session: the SPA captures the token and `GET /me` returns the user. In the
   browser, the dashboard should render as the signed-in user (`MuditGarg007`).
4. Confirm the token round-trips through Vault: a row exists in `github_tokens` with a value
   starting `vault:v1:` (ciphertext only), and a later engagement clone can decrypt it.

## Guardrails

- **Do not** disable or stub `VaultService` encryption to "get past" this — the encrypted
  token-at-rest is a stated security invariant (`docs/control-plane.md` §4.A / secret split).
  Stand up a real Vault instead.
- **Do not** put `OPENROUTER_API_KEY` anywhere in the plane or this secret — it is
  conductor/harness-side only; the CI leak scanner and the chart forbid it.
- If you add a `VAULT_TOKEN` (Path A), it is a dev credential — treat it as a secret, keep it
  only in the k8s Secret, and plan to remove it when Path B lands.
- The NodePort + Caddy exposure and the OAuth app config are already correct; this task is
  only the Vault dependency.
