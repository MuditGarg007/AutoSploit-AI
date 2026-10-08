"""booter — BuildPlan → running labeled container (docs/provisioner.md §4 row 3, M3).

First Docker touch. `boot(plan, tag, engagement_id)` runs the §4-row-3 recipe:
`docker build -t <tag> <ctx>` then `docker run -d -P --label engagement=<id> <tag>`.
`-P` (`publish_all_ports`) auto-publishes every `EXPOSE`d port so discovery (M4) has
real host bindings to read. `run_image(image_ref, engagement_id)` is the image-source
shortcut — no build, just the labeled run.

Every container is stamped with `ENGAGEMENT_LABEL=<id>` so teardown (M5) can
`docker rm -f` by label. On a build failure we capture the build **log tail** onto
the raised `BuildFailed` (§8) and never start a container — so the failed path leaks
no half-built run.
"""

from __future__ import annotations

from docker.errors import BuildError
from docker.models.containers import Container

from ..contracts.errors import BuildFailed
from ..contracts.plan import BuildPlan
from ..docker_env import docker_client

# The label key teardown queries (`docker ps -f label=engagement=<id>`), kept here
# because the booter is the one slice that stamps it on.
ENGAGEMENT_LABEL = "engagement"

# Trailing build-output lines attached to a BuildFailed (§8 "log tail").
_BUILD_LOG_TAIL_LINES = 40


def boot(plan: BuildPlan, tag: str, engagement_id: str) -> Container:
    """Build `plan` as `tag`, then run it detached + port-published + labeled.

    Raises `BuildFailed` (carrying a `.log_tail`, §8) if the build fails, before any
    container is created. On success returns the running, `engagement`-labeled
    container for discovery to inspect.
    """
    client = docker_client()
    try:
        client.images.build(
            path=str(plan.context),
            dockerfile=_dockerfile_arg(plan),
            tag=tag,
            rm=True,
            forcerm=True,  # drop intermediate containers even on a failed build
        )
    except BuildError as exc:
        raise _build_failed(exc) from exc

    return _run_labeled(client, tag, engagement_id)


def run_image(image_ref: str, engagement_id: str) -> Container:
    """Run a prebuilt `image_ref` detached + port-published + labeled (image source, §4 row 1)."""
    return _run_labeled(docker_client(), image_ref, engagement_id)


def _run_labeled(client, image_ref: str, engagement_id: str) -> Container:
    """`docker run -d -P --label engagement=<id> <image_ref>` via docker-py."""
    return client.containers.run(
        image_ref,
        detach=True,
        publish_all_ports=True,
        labels={ENGAGEMENT_LABEL: engagement_id},
    )


def _dockerfile_arg(plan: BuildPlan) -> str:
    """docker-py wants `dockerfile` relative to the build context; derive it from the plan."""
    try:
        return str(plan.dockerfile.relative_to(plan.context))
    except ValueError:
        # Dockerfile outside the context dir — fall back to its bare name.
        return plan.dockerfile.name


def _build_failed(exc: BuildError) -> BuildFailed:
    """Wrap a docker-py `BuildError` as `BuildFailed` carrying the build-log tail (§8)."""
    tail = _build_log_tail(exc)
    err = BuildFailed(f"docker build failed:\n{tail}" if tail else "docker build failed")
    err.log_tail = tail  # programmatic access for the manifest/CLI
    return err


def _build_log_tail(exc: BuildError) -> str:
    """Last `_BUILD_LOG_TAIL_LINES` non-empty lines of `exc.build_log` (stream/error chunks)."""
    lines: list[str] = []
    for chunk in getattr(exc, "build_log", None) or ():
        text = (chunk.get("stream") or chunk.get("error") or "") if isinstance(chunk, dict) else str(chunk)
        text = text.strip()
        if text:
            lines.append(text)
    if not lines and getattr(exc, "msg", None):
        lines.append(str(exc.msg))
    return "\n".join(lines[-_BUILD_LOG_TAIL_LINES:])
