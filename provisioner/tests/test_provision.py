"""M6 gate (docs/provisioner.md §11 M6): one command emits a valid scope + tears down.

Integration — needs a Docker daemon (`@pytest.mark.integration`). Two paths:
- full run against the M3 webserver fixture → scope + manifest on disk, the scope
  parses through the harness `load_scope` to the discovered ports, the container is
  up; then teardown leaves zero residue;
- failure injection (a Dockerfile whose build fails) → the CLI exits non-zero with
  the §8 message and no orphan container is left behind.

Each test tears its own containers/images down by the `engagement` label.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import docker
import pytest
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.driver.config import load_scope

from autosploit_provisioner import cli
from autosploit_provisioner.build.booter import ENGAGEMENT_LABEL
from autosploit_provisioner.provision import HOST, provision
from autosploit_provisioner.teardown import teardown

pytestmark = pytest.mark.integration

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "webserver"


@pytest.fixture
def client() -> docker.DockerClient:
    return docker.from_env()


@pytest.fixture
def engagement_id() -> str:
    return f"m6-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def cleanup(client: docker.DockerClient, engagement_id: str):
    """Remove every container carrying this test's engagement label, plus tagged images."""
    tags: list[str] = [f"autosploit-provisioner/{engagement_id}:latest"]
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


def test_full_run_emits_scope_and_manifest_then_teardown_clean(
    client, engagement_id, cleanup, tmp_path
):
    out = tmp_path / "eng"

    result = provision(str(_FIXTURE_DIR), engagement_id, out)

    # Scope + manifest landed on disk.
    assert result.scope_path.exists()
    assert result.manifest_path.exists()

    # The frozen seam: the emitted scope parses through the harness's own parser to
    # exactly the discovered host + ports (§3, the load-bearing assertion).
    assert load_scope(result.scope_path) == ScopeAllowlist(host=HOST, ports=result.ports)

    # Container is up and labeled for this engagement.
    assert result.container_ids
    container = client.containers.get(result.container_ids[0])
    assert container.status == "running"
    assert _label_containers(client, engagement_id)

    # Success does not tear down — the caller does, after the engagement.
    teardown(engagement_id, out)
    assert _label_containers(client, engagement_id) == []


def test_broken_dockerfile_nonzero_exit_no_orphan(client, engagement_id, cleanup, tmp_path):
    # A Dockerfile that builds-fails: EXPOSE is set, but a RUN aborts the build.
    (tmp_path / "Dockerfile").write_text(
        "FROM python:3.12-slim\nEXPOSE 8000\nRUN exit 1\n", encoding="utf-8"
    )
    out = tmp_path / "eng"

    code = cli.main(
        [str(tmp_path), "--engagement-id", engagement_id, "--out", str(out)]
    )

    # §8: reject/failure → non-zero exit.
    assert code == 1
    # provision() already tore down on the way out — no orphan for the label.
    assert _label_containers(client, engagement_id) == []
