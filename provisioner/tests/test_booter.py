"""M3 gate (docs/provisioner.md §11 M3): booter builds + runs a labeled container.

Integration — needs a Docker daemon (`@pytest.mark.integration`). Leans on the tiny
in-repo fixture image (`tests/fixtures/webserver/Dockerfile`). Each test tears down
its own artifacts by the `engagement` label so a failing run leaves no residue.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import docker
import pytest

from autosploit_provisioner.build.booter import ENGAGEMENT_LABEL, boot
from autosploit_provisioner.contracts.errors import BuildFailed
from autosploit_provisioner.contracts.plan import BuildPlan

pytestmark = pytest.mark.integration

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "webserver"


@pytest.fixture
def client() -> docker.DockerClient:
    return docker.from_env()


@pytest.fixture
def engagement_id() -> str:
    """A unique engagement id per test so label queries never collide across runs."""
    return f"m3-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def cleanup(client: docker.DockerClient, engagement_id: str):
    """Remove every container carrying this test's engagement label, plus tagged images."""
    tags: list[str] = []
    yield tags
    for c in client.containers.list(all=True, filters={"label": f"{ENGAGEMENT_LABEL}={engagement_id}"}):
        c.remove(force=True)
    for tag in tags:
        try:
            client.images.remove(tag, force=True)
        except docker.errors.ImageNotFound:
            pass


def test_boot_builds_runs_and_labels(client, engagement_id, cleanup):
    tag = f"autosploit-test/{engagement_id}:latest"
    cleanup.append(tag)
    plan = BuildPlan(branch="dockerfile", context=_FIXTURE_DIR, dockerfile=_FIXTURE_DIR / "Dockerfile")

    container = boot(plan, tag, engagement_id)

    assert container.id
    container.reload()
    assert container.labels[ENGAGEMENT_LABEL] == engagement_id
    # Gate: label is queryable exactly like `docker ps -f label=engagement=<id>`.
    found = client.containers.list(filters={"label": f"{ENGAGEMENT_LABEL}={engagement_id}"})
    assert container.id in {c.id for c in found}


def test_boot_broken_dockerfile_raises_buildfailed_no_orphan(client, engagement_id, cleanup, tmp_path):
    (tmp_path / "Dockerfile").write_text("FROM python:3.12-slim\nRUN exit 1\n")
    tag = f"autosploit-test/{engagement_id}:latest"
    cleanup.append(tag)
    plan = BuildPlan(branch="dockerfile", context=tmp_path, dockerfile=tmp_path / "Dockerfile")

    with pytest.raises(BuildFailed) as exc:
        boot(plan, tag, engagement_id)

    assert exc.value.log_tail  # §8: log tail attached
    # No container was created on the failed build path.
    orphans = client.containers.list(all=True, filters={"label": f"{ENGAGEMENT_LABEL}={engagement_id}"})
    assert orphans == []
