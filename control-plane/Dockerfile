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
FROM oven/bun:1.1.0 AS build
WORKDIR /app
# Copy the whole workspace before installing. bun.lock resolves against the full
# workspace graph (client + control-plane + packages/*), so a frozen install needs
# every workspace's package.json present; a partial copy resolves a different graph
# and fails with "lockfile had changes, but lockfile is frozen". .dockerignore keeps
# node_modules/dist/.env/.git out of the context, so this stays slim and secret-free.
COPY . .
RUN bun install --frozen-lockfile
# turbo build: @autosploit/contracts (tsc) then control-plane (nest build). turbo's
# ^build dependsOn pulls in contracts; the filter skips the client workspace.
RUN bunx turbo run build --filter=@autosploit/control-plane

# ---------- Runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Non-root runtime user (image hardening, §8.1).
RUN groupadd -r autosploit && useradd -r -g autosploit -m autosploit
WORKDIR /app
COPY --from=build --chown=autosploit:autosploit /app/node_modules ./node_modules
COPY --from=build --chown=autosploit:autosploit /app/packages ./packages
COPY --from=build --chown=autosploit:autosploit /app/control-plane/dist ./control-plane/dist
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