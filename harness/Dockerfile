# Harness (attacker) image — the AutoSploit attack engine (docs/harness.md).
# Roadmap M5: this image is built, scanned, and pushed to GHCR, and the cluster
# pulls it by digest to run the attacker Pod (deploy/helm/engagement attacker).
#
#   Build stage:   python:3.12-slim + uv → resolve the frozen lockfile and install
#                  the autosploit-harness package into a self-contained venv.
#   Runtime stage: slim python 3.12, non-root user, the venv only.
#
# The image carries NO secrets. OPENROUTER_API_KEY is delivered at runtime as a k8s
# Secret (attacker Pod `secretKeyRef`, deploy/helm/engagement), never baked here —
# the CI leak scan (release.yml) fails the build if a reference is found. Mirrors the
# hardening of control-plane/Dockerfile (multi-stage, non-root, secret-free).

# ---------- Build stage ----------
FROM python:3.12-slim AS build
# Pinned uv (astral distroless image) — reproducible resolver, no pip bootstrap.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0
WORKDIR /app
# Lockfile + metadata first for layer caching; README is referenced by pyproject
# (`readme = "README.md"`) so hatchling needs it present at build.
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
# --no-dev: no test/lint deps in the image. --no-editable: install a real copy of
# the package into the venv (not a link back to /app/src), so the runtime stage
# needs only the venv.
RUN uv sync --frozen --no-dev --no-editable

# ---------- Runtime stage ----------
FROM python:3.12-slim AS runtime
# Non-root runtime user (image hardening).
RUN groupadd -r autosploit && useradd -r -g autosploit -m autosploit
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"
USER autosploit

# `autosploit-harness run --config <mount>/run.toml`. The run-config ConfigMap
# mounts at /etc/autosploit in the engagement chart (values.yaml attacker.*), and
# the model key arrives via the Secret env at runtime.
ENTRYPOINT ["autosploit-harness"]
CMD ["run", "--config", "/etc/autosploit/run.toml"]
