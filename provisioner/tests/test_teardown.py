"""M5 gate (docs/provisioner.md §11 M5): teardown-by-label leaves zero residue, idempotent.

Integration — needs a Docker daemon (`@pytest.mark.integration`). Boots the M3
webserver fixture, tears it down by the `engagement` label, and asserts `docker ps
-a` shows nothing for that label; then calls teardown a second time and asserts it
is a no-op (§8). Also asserts the workdir is removed and a repeat call on a missing
workdir does not raise.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import docker
import pytest

from autosploit_provisioner.build.booter import ENGAGEMENT_LABEL, boot
from autosploit_provisioner.contracts.plan import BuildPlan
from autosploit_provisioner.teardown import teardown

pytestmark = pytest.mark.integration

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "webserver"


@pytest.fixture
def client() -> docker.DockerClient:
    return docker.from_env()


@pytest.fixture
def engagement_id() -> str:
    return f"m5-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def cleanup(client: docker.DockerClient, engagement_id: str):
    """Safety net: remove any leftover container/image even if the test's teardown fails."""
    tags: list[str] = []
    yield tags
    for c in client.containers.list(
        all=True, filters={"label": f"{ENGAGEMENT_LABEL}={engagement_id}"}
    ):
        c.remove(force=True)
    for tag in tags:
        try:
            client.images.remove(tag, force=True)
        except docker.errors.ImageNotFound:
            pass


def _label_containers(client, engagement_id):
    return client.containers.list(
        all=True, filters={"label": f"{ENGAGEMENT_LABEL}={engagement_id}"}
    )


def test_teardown_removes_by_label_and_is_idempotent(client, engagement_id, cleanup, tmp_path):
    tag = f"autosploit-test/{engagement_id}:latest"
    cleanup.append(tag)
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "marker").write_text("x", encoding="utf-8")

    plan = BuildPlan(
        branch="dockerfile", context=_FIXTURE_DIR, dockerfile=_FIXTURE_DIR / "Dockerfile"
    )
    boot(plan, tag, engagement_id)
    assert _label_containers(client, engagement_id)  # precondition: it's really up

    teardown(engagement_id, workdir)

    # Gate: zero residue for the label, workdir gone.
    assert _label_containers(client, engagement_id) == []
    assert not workdir.exists()

    # Idempotent: a second call finds nothing and does not raise (§8).
    teardown(engagement_id, workdir)
    assert _label_containers(client, engagement_id) == []
