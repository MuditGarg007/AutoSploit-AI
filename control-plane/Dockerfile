# Control plane image (docs/component-h-hardening.md §8.1). One image runs both the
# HTTP app and the BullMQ worker (same monolith, selected by a start flag / CMD).
#
#   Build stage:  Bun (monorepo package manager) → turbo build (contracts tsc then
#                 control-plane nest build). The runtime stays Node 22 (§9.1).
#   Runtime stage: slim Node 22, non-root user, built dist/ + prod deps only.
#
# The image carries NO secrets: GitHub tokens / ingest signing keys / Vault are
# injected at deploy time as k8s Secrets / Vault; OPENROUTER_API_KEY never enters
# this image by design (§3.6, §5.2 — the model key is conductor-only).

# ---------- Build stage ----------
# bun >=1.2 is required: bun.lock is the text lockfile (lockfileVersion 1), which the
# old 1.1.0 image cannot parse — a frozen install under 1.1.0 fails with "lockfile had
# changes, but lockfile is frozen" even over a correct, full-workspace tree. Pin 1.4.0
# to match the dev box and keep CI/local/box builds on one bun.
FROM oven/bun:1.4.0 AS build
WORKDIR /app
# Copy the whole workspace before installing. bun.lock resolves against the full
# workspace graph (client + control-plane + packages/*), so a frozen install needs
# every workspace's package.json present; a partial copy resolves a different graph
# and also fails with "lockfile had changes, but lockfile is frozen". .dockerignore
# keeps node_modules/dist/.env/.git out of the context, so this stays slim and secret-free.
COPY . .
RUN bun install --frozen-lockfile
# turbo build: @autosploit/contracts (tsc) then control-plane (nest build). turbo's
# ^build dependsOn pulls in contracts; the filter skips the client workspace.
RUN bunx turbo run build --filter=@autosploit/control-plane

# ---------- Runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Patch OS packages: the node:22-slim (Debian bookworm) base lags its distro's
# security updates, so Trivy flags fixable HIGH/CRITICAL OS CVEs (e.g. perl-base,
# util-linux). Upgrade in place and drop the apt lists to keep the layer slim and
# secret-free. Runs as root — must precede the USER switch below.
RUN apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*
# Non-root runtime user (image hardening, §8.1).
RUN groupadd -r autosploit && useradd -r -g autosploit -m autosploit
WORKDIR /app
COPY --from=build --chown=autosploit:autosploit /app/node_modules ./node_modules
COPY --from=build --chown=autosploit:autosploit /app/packages ./packages
# bun >=1.2 uses an isolated install layout: the root node_modules holds only the
# .bun content store, while each workspace's node_modules holds the symlinks that
# resolve into it (e.g. control-plane/node_modules/reflect-metadata -> ../../node_modules/.bun/...).
# dist/main.js resolves its deps through control-plane/node_modules, so that dir must
# ship too — without it every top-level import (reflect-metadata, @nestjs/*, the
# @autosploit/contracts workspace link) fails with ERR_MODULE_NOT_FOUND at boot.
COPY --from=build --chown=autosploit:autosploit /app/control-plane/node_modules ./control-plane/node_modules
COPY --from=build --chown=autosploit:autosploit /app/control-plane/dist ./control-plane/dist
# Ship the SQL migrations next to the compiled migrate runner (dist/db/migrations)
# so the Helm pre-upgrade hook can apply the schema with `node dist/db/migrate.js`
# (deploy/helm/control-plane/templates/migrate-job.yaml). tsc does not emit .sql/
# .json, so copy them explicitly from the build stage's source tree.
COPY --from=build --chown=autosploit:autosploit /app/control-plane/src/db/migrations ./control-plane/dist/db/migrations
COPY --from=build --chown=autosploit:autosploit /app/control-plane/package.json ./control-plane/package.json
# Some bun-installed files land mode 0600/root-only; ensure the non-root runtime
# user can read every module and traverse every dir (EACCES otherwise at import).
RUN chmod -R a+rX /app
USER autosploit

# Default: start the HTTP control plane. The Nest app boots the BullMQ worker in
# the same process (the module factory registers the Worker), so this one image is
# both the app and the worker — a single long-lived Deployment (§8.1, §3.5).
EXPOSE 3000
WORKDIR /app/control-plane
CMD ["node", "dist/main.js"]