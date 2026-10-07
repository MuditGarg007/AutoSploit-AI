# VPS backend public exposure — Caddy + NodePort (reproducible runbook)

**Date:** 2026-10-07
**Box:** Contabo `root@169.58.86.230`, kind cluster `autosploit-hardening`
**Public URL:** `https://api.autosploit.muditgarg.xyz`
**Predecessor:** `docs/vps-backend-deploy-handoff.md` (got the backend running in-cluster),
`docs/vps-ghcr-image-fix-handoff.md` (fixed the GHCR image so the released build boots).
This runbook covers the last mile: exposing the in-cluster backend to the internet
over HTTPS.

## What this sets up

```
internet :443  ->  Caddy (host, auto-TLS)  ->  172.18.0.2:30080 (kind node NodePort)  ->  control-plane pod :3000
```

The helm chart only ships a **ClusterIP** Service (`control-plane-control-plane`,
`:80 -> :3000`), reachable only inside the kind cluster. A host-level reverse proxy
cannot reach a ClusterIP, so a standalone **NodePort** Service bridges host → cluster,
and **Caddy** on the host terminates TLS and proxies to it.

Design choices:

- The NodePort Service is **not** part of the helm release, so `helm upgrade` never
  drifts or deletes it. Trade-off: it must be re-applied by hand if the kind cluster is
  ever recreated.
- Caddy runs as a host systemd service (not in the cluster), so TLS and the public
  listener survive cluster churn.
- Caddy fetches and **auto-renews** the Let's Encrypt certificate; no cron needed.

Artifacts checked into the repo:

- `deploy/vps/control-plane-nodeport.yaml` — the NodePort Service.
- `deploy/vps/Caddyfile` — the host Caddy config (mirror of `/etc/caddy/Caddyfile`).

## Prerequisites

- Backend healthy in-cluster: `control-plane-control-plane-app` pod `1/1 Running`, and
  the helm `control-plane` ClusterIP Service present in namespace `autosploit-system`.
- Ports 80 and 443 reachable from the internet (host `ufw` is inactive; confirm the
  Contabo panel has no external firewall blocking them).
- Control over DNS for `muditgarg.xyz` (hosted at Hostinger).

## Step 1 — DNS A record

In the Hostinger hPanel: **Domains → muditgarg.xyz → DNS / Nameservers → DNS Zone**, add:

| Type | Name            | Points to       | TTL  |
|------|-----------------|-----------------|------|
| A    | `api.autosploit`| `169.58.86.230` | 3600 |

The Name field is relative to `muditgarg.xyz`, so enter only `api.autosploit` (Hostinger
appends the zone). Verify propagation:

```bash
dig +short @1.1.1.1 api.autosploit.muditgarg.xyz   # -> 169.58.86.230
dig +short @8.8.8.8 api.autosploit.muditgarg.xyz   # -> 169.58.86.230
```

## Step 2 — NodePort bridge

The kind node container IP is needed by Caddy. Confirm it:

```bash
docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "$(docker ps -q --filter name=autosploit-hardening-control-plane)"
# -> /autosploit-hardening-control-plane 172.18.0.2
```

If the IP is not `172.18.0.2`, update `172.18.0.2` in both `deploy/vps/Caddyfile` and the
live `/etc/caddy/Caddyfile`.

Apply the NodePort Service and verify the host → node → pod path:

```bash
kubectl apply -f deploy/vps/control-plane-nodeport.yaml
curl -s http://172.18.0.2:30080/health   # -> {"status":"ok","db":"up"}
```

## Step 3 — Install and configure Caddy

Install (official apt repo, Debian/Ubuntu):

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Install the config (copy the repo's `deploy/vps/Caddyfile` to the host):

```bash
install -m 0644 deploy/vps/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile   # -> Valid configuration
systemctl restart caddy
systemctl status caddy --no-pager | head -12
```

On the first request Caddy completes a TLS-ALPN-01 challenge with Let's Encrypt and
installs the certificate (a few seconds).

## Step 4 — Verify from outside

```bash
curl -s https://api.autosploit.muditgarg.xyz/health
# -> {"status":"ok","db":"up"}

curl -sv https://api.autosploit.muditgarg.xyz/health 2>&1 \
  | grep -iE 'issuer:|subject:|expire|HTTP/'
# subject CN=api.autosploit.muditgarg.xyz, issuer Let's Encrypt, HTTP/2 200

curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
  http://api.autosploit.muditgarg.xyz/health
# -> 308 -> https://api.autosploit.muditgarg.xyz/health
```

## Verified live (2026-10-07)

- `https://api.autosploit.muditgarg.xyz/health` → `{"status":"ok","db":"up"}`, HTTP/2 200.
- Certificate: Let's Encrypt, CN `api.autosploit.muditgarg.xyz`, expires 2027-01-05,
  auto-renewed by Caddy.
- HTTP → HTTPS 308 redirect in place.

## Recovery / gotchas

- **Cluster recreated** → the NodePort Service is gone (not helm-managed). Re-apply
  `deploy/vps/control-plane-nodeport.yaml`. Caddy and the host config are unaffected.
- **kind node IP changed** (e.g. docker network rebuilt) → update `172.18.0.2` in
  `/etc/caddy/Caddyfile` and restart Caddy.
- **Cert fails to issue** → ports 80/443 must be reachable from the internet; check the
  Contabo external firewall and that nothing else binds those ports on the host
  (`ss -tlnp | grep -E ':(80|443) '`).
- **NodePort 30080 conflict** → pick another port in 30000–32767 and update both the
  manifest and the Caddy `reverse_proxy` target.
