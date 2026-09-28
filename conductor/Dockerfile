# Conductor image (M5 Phase 6, docs/m5-phases.md). Runs the conductor that owns one
# engagement end to end; the M5 mirror path shells out to two external binaries that
# must therefore be baked in:
#
#   git   — the conductor-side clone (autosploit_provisioner.source.cloner) that
#           preloads the repo into a build-context ConfigMap under the live M7 egress.
#   crane — the base-image mirror (k8s/mirror.py `crane copy`) that preloads each
#           external `FROM` base into the per-engagement in-cluster registry. crane
#           talks the registry HTTP API directly, so there is NO docker socket here.
#
#   Build stage:   python:3.12-slim + uv → resolve conductor's frozen lockfile and
#                  install the package (with its sibling path deps provisioner +
#                  harness) into a self-contained venv.
#   Runtime stage: slim python 3.12, git + crane + ca-certificates, non-root user,
#                  the venv only.
#
# BUILD CONTEXT IS THE REPO ROOT, not ./conductor: conductor depends on the sibling
# packages ../provisioner and ../harness via `[tool.uv.sources]` path sources
# (conductor → provisioner → harness), which live outside a ./conductor context.
# Build with:  docker build -f conductor/Dockerfile -t conductor:proof .
#
# The image carries NO secrets. OPENROUTER_API_KEY is conductor-only at RUNTIME
# (injected as a k8s Secret env), never baked here — mirrors the hardening of
# control-plane/Dockerfile and harness/Dockerfile (multi-stage, non-root, secret-free).

# ---------- crane binary (ko-built distroless image; binary at /ko-app/crane) ----------
FROM gcr.io/go-containerregistry/crane:v0.22.1 AS crane

# ---------- Build stage ----------
FROM python:3.12-slim AS build
# Pinned uv (astral distroless image) — reproducible resolver, no pip bootstrap.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0
WORKDIR /app
# Replicate the repo layout so conductor's `../provisioner` / `../harness` path
# sources (and provisioner's own `../harness`) resolve. Lockfile + metadata first
# for layer caching; each README is referenced by its pyproject (`readme = ...`) so
# hatchling needs it present at build.
COPY harness/pyproject.toml harness/uv.lock harness/README.md ./harness/
COPY harness/src ./harness/src
COPY provisioner/pyproject.toml provisioner/uv.lock provisioner/README.md ./provisioner/
COPY provisioner/src ./provisioner/src
COPY conductor/pyproject.toml conductor/uv.lock conductor/README.md ./conductor/
COPY conductor/src ./conductor/src
WORKDIR /app/conductor
# --no-dev: no test/lint deps in the image. --no-editable: install real copies of
# conductor + the sibling path deps into the venv (not links back to /app/*/src), so
# the runtime stage needs only the venv.
RUN uv sync --frozen --no-dev --no-editable

# ---------- Runtime stage ----------
FROM python:3.12-slim AS runtime
# git + ca-certificates for the conductor-side clone and crane/git TLS to external
# hosts (the conductor has egress; the build Pod does not). --no-install-recommends
# keeps the surface small; clean the apt lists to avoid shipping the cache.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# crane, baked in for the base-image mirror (k8s/mirror.py).
COPY --from=crane /ko-app/crane /usr/local/bin/crane
# Non-root runtime user (image hardening).
RUN groupadd -r autosploit && useradd -r -g autosploit -m autosploit
WORKDIR /app
COPY --from=build /app/conductor/.venv /app/conductor/.venv
ENV PATH="/app/conductor/.venv/bin:$PATH"
USER autosploit

# No ENTRYPOINT: the console script `conductor` is the default CMD, but leaving the
# entrypoint unset lets the baked binaries run directly for verification
# (`docker run conductor:proof git --version`, `--entrypoint crane ... version`).
CMD ["conductor"]
