"""M4 gate (docs/provisioner.md §11 M4): discovery finds the host port; both rejects fire.

Integration — needs a Docker daemon (`@pytest.mark.integration`). Boots real
containers via the M3 booter and inspects them:
- the M3 webserver fixture (EXPOSE 8000) → discovers its published host port;
- an EXPOSE-less but running image → `NoPortsExposed`;
- a container that exits immediately → `BootTimeout` with a captured log tail.

Each test tears its own containers/images down by the `engagement` label.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import docker
import pytest

from autosploit_provisioner.build.booter import ENGAGEMENT_LABEL, boot
from autosploit_provisioner.contracts.errors import BootTimeout, NoPortsExposed
from autosploit_provisioner.contracts.plan import BuildPlan
from autosploit_provisioner.discovery import Ports, discover

pytestmark = pytest.mark.integration

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "webserver"


@pytest.fixture
def client() -> docker.DockerClient:
    return docker.from_env()


@pytest.fixture
def engagement_id() -> str:
    return f"m4-{uuid.uuid4().hex[:12]}"


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


def test_discovers_published_host_port(engagement_id, cleanup):
    tag = f"autosploit-test/{engagement_id}:latest"
    cleanup.append(tag)
    plan = BuildPlan(branch="dockerfile", context=_FIXTURE_DIR, dockerfile=_FIXTURE_DIR / "Dockerfile")
    container = boot(plan, tag, engagement_id)

    ports = discover(container, timeout_s=30.0, backoff=0.1)

    assert isinstance(ports, Ports)
    # Gate: fixture EXPOSEs 8000 → -P binds it to exactly one ephemeral host port.
    assert len(ports.host) == 1
    assert all(isinstance(p, int) and p > 0 for p in ports.host)


def test_exposeless_image_rejects_no_ports(engagement_id, cleanup, tmp_path):
    # Running, but EXPOSEs nothing → nothing published → NoPortsExposed (§8).
    (tmp_path / "Dockerfile").write_text('FROM python:3.12-slim\nCMD ["sleep", "60"]\n')
    tag = f"autosploit-test/{engagement_id}:latest"
    cleanup.append(tag)
    plan = BuildPlan(branch="dockerfile", context=tmp_path, dockerfile=tmp_path / "Dockerfile")
    container = boot(plan, tag, engagement_id)

    with pytest.raises(NoPortsExposed):
        discover(container, timeout_s=15.0, backoff=0.1)


def test_container_exits_immediately_rejects_boottimeout(engagement_id, cleanup, tmp_path):
    # Exits before ever becoming ready → BootTimeout with the container-log tail (§8).
    (tmp_path / "Dockerfile").write_text('FROM python:3.12-slim\nCMD ["sh", "-c", "echo boom; exit 1"]\n')
    tag = f"autosploit-test/{engagement_id}:latest"
    cleanup.append(tag)
    plan = BuildPlan(branch="dockerfile", context=tmp_path, dockerfile=tmp_path / "Dockerfile")
    container = boot(plan, tag, engagement_id)

    with pytest.raises(BootTimeout) as exc:
        discover(container, timeout_s=15.0, backoff=0.1)

    assert "boom" in exc.value.log_tail  # §8: container logs captured on the reject
