# Control plane image (docs/component-h-hardening.md §8.1). One image runs both the
# HTTP app and the BullMQ worker (same monolith, selected by a start flag / CMD).
#
#   Build stage:  Bun (monorepo package manager) → turbo build (contracts tsc then
#                 control-plane nest build).
#   Runtime stage: python:3.12-slim base carrying the conductor (venv + git +
#                 crane + helm + the engagement Helm chart) PLUS the node binary
#                 that runs the control-plane app. The worker shells `conductor
#                 run --k8s`, so the conductor has to be runnable in this image
#                 (engagement pipeline handoff #2; architecture A — the conductor
#                 runs in-process in the plane pod rather than as a separate Job).
#                 The base is python (not node) because dropping a self-contained
#                 node binary into a python image is far cheaper than making a
#                 full CPython + its C-extension libs work inside a node image.
#
# The image carries NO secrets: GitHub tokens / ingest signing keys / Vault are
# injected at deploy time as k8s Secrets / Vault, and OPENROUTER_API_KEY is still
# never BAKED here. Note the hardening shift: with architecture A the conductor
# runs inside the plane pod, so the model key is now injected into that pod's env
# at deploy time (Helm secretRef) — it no longer lives only in a separate
# conductor pod. That relaxes the §6 secret-split SEAM-2 boundary by design
# (accepted tradeoff for the fat-image path); the key is still absent from the
# image layers themselves.

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

# ---------- crane binary (ko-built distroless image; binary at /ko-app/crane) ----------
# For the conductor's base-image mirror (k8s/mirror.py `crane copy`), mirrors
# conductor/Dockerfile.
FROM gcr.io/go-containerregistry/crane:v0.22.1 AS crane

# ---------- helm binary (static Go binary at /usr/bin/helm) ----------
# For the conductor's M9 engagement-release install/uninstall (k8s/helm.py shells
# `helm`).
FROM alpine/helm:3.16.2 AS helm

# ---------- node binary source ----------
# The control-plane app runs `node dist/main.js`. node:22-slim's node is a
# self-contained binary (glibc + libstdc++ only), so we lift just the binary into
# the python-based runtime below rather than merging two /usr/local trees.
FROM node:22-slim AS node-bin

# ---------- conductor venv build ----------
# Mirrors conductor/Dockerfile's build stage: resolve the conductor's frozen
# lockfile (with its sibling path deps provisioner + harness) into a self-contained
# venv. BUILD CONTEXT IS THE REPO ROOT (the control-plane image is built from root),
# so ../provisioner and ../harness are present.
FROM python:3.12-slim AS conductor-build
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_HTTP_TIMEOUT=120
WORKDIR /app
COPY harness/pyproject.toml harness/uv.lock harness/README.md ./harness/
COPY harness/src ./harness/src
COPY provisioner/pyproject.toml provisioner/uv.lock provisioner/README.md ./provisioner/
COPY provisioner/src ./provisioner/src
COPY conductor/pyproject.toml conductor/uv.lock conductor/README.md ./conductor/
COPY conductor/src ./conductor/src
WORKDIR /app/conductor
# --no-dev: no test/lint deps. --no-editable: install real copies into the venv, so
# the runtime stage needs only the venv (not /app/*/src).
RUN uv sync --frozen --no-dev --no-editable

# ---------- Runtime stage ----------
# python:3.12-slim so the conductor's CPython + kubernetes-client TLS work natively;
# the node binary is lifted in from node-bin. Same Debian bookworm base as node:22-slim
# and conductor/Dockerfile, so glibc matches across all lifted binaries.
FROM python:3.12-slim AS runtime
ENV NODE_ENV=production
# Patch OS packages (Trivy fixable HIGH/CRITICAL), and install the conductor's
# runtime deps: git (the conductor-side clone), ca-certificates (crane/git TLS),
# and libstdc++6 (the lifted node binary links it). --no-install-recommends +
# dropping the apt lists keeps the layer slim and secret-free. Runs as root —
# must precede the USER switch below.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
# Non-root runtime user (image hardening, §8.1).
RUN groupadd -r autosploit && useradd -r -g autosploit -m autosploit
# The node runtime, and the conductor's baked-in binaries.
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node
COPY --from=crane /ko-app/crane /usr/local/bin/crane
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
# The conductor venv (self-contained; its console script is /app/conductor/.venv/bin/conductor).
COPY --from=conductor-build --chown=autosploit:autosploit /app/conductor/.venv /app/conductor/.venv
# The per-engagement Helm chart the conductor's --k8s path installs (M9). With
# --no-editable the package's in-repo default chart path does not resolve, so ship
# the chart explicitly and point AUTOSPLOIT_ENGAGEMENT_CHART at it (cli.py override).
COPY --from=build --chown=autosploit:autosploit /app/deploy/helm/engagement /app/engagement-chart
# conductor on PATH (CONDUCTOR_CMD default = `conductor`); the model key, chart path
# and k8s mode are wired by the Helm chart's env at deploy time.
ENV PATH="/app/conductor/.venv/bin:${PATH}" \
    AUTOSPLOIT_ENGAGEMENT_CHART=/app/engagement-chart
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