"""docker_env — one shared docker-py client for the Docker-touching slices (M3+).

`docker.from_env()` reads `DOCKER_HOST` et al. and opens a connection, so we make it
once and hand the same client to the booter (M3), discovery (M4), and teardown (M5).
Lazily created on first call so importing the pure slices (resolver/cloner, M1/M2)
never touches a daemon — the pure test suite stays runnable with no Docker present.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from docker import DockerClient

_client: DockerClient | None = None


def docker_client() -> DockerClient:
    """Return the process-wide docker-py client, creating it on first use."""
    global _client
    if _client is None:
        import docker

        _client = docker.from_env()
    return _client
