"""M1 gate (docs/provisioner.md §11 M1): resolver ladder + exact reject paths.

Pure, tmp_path only, zero Docker. Every §8 reject string asserted verbatim —
those strings are the contract with the CLI/conductor, so they are pinned here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from autosploit_provisioner.build.resolver import resolve_build
from autosploit_provisioner.contracts.errors import ProvisionError, UnsupportedBuild
from autosploit_provisioner.contracts.plan import BuildPlan


def test_dockerfile_only_yields_plan(tmp_path: Path) -> None:
    df = tmp_path / "Dockerfile"
    df.write_text("FROM scratch\n")

    plan = resolve_build(tmp_path)

    assert isinstance(plan, BuildPlan)
    assert plan.branch == "dockerfile"
    assert plan.context == tmp_path
    assert plan.dockerfile == df


def test_compose_only_rejects_with_deferred_message(tmp_path: Path) -> None:
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")

    with pytest.raises(UnsupportedBuild) as exc:
        resolve_build(tmp_path)

    assert str(exc.value) == "compose deferred, Dockerfile only for MVP"


@pytest.mark.parametrize("name", ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"])
def test_all_compose_filenames_rejected(tmp_path: Path, name: str) -> None:
    (tmp_path / name).write_text("services: {}\n")

    with pytest.raises(UnsupportedBuild) as exc:
        resolve_build(tmp_path)

    assert str(exc.value) == "compose deferred, Dockerfile only for MVP"


def test_empty_dir_rejects_with_no_dockerfile_message(tmp_path: Path) -> None:
    with pytest.raises(UnsupportedBuild) as exc:
        resolve_build(tmp_path)

    assert str(exc.value) == "no Dockerfile; nothing to build"


def test_dockerfile_wins_when_both_present(tmp_path: Path) -> None:
    """Documented precedence: Dockerfile beats compose when both sit in the dir."""
    df = tmp_path / "Dockerfile"
    df.write_text("FROM scratch\n")
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")

    plan = resolve_build(tmp_path)

    assert plan.branch == "dockerfile"
    assert plan.dockerfile == df


def test_dockerfile_directory_is_not_usable(tmp_path: Path) -> None:
    """A `Dockerfile` that is a directory is not a file — falls through to reject."""
    (tmp_path / "Dockerfile").mkdir()

    with pytest.raises(UnsupportedBuild) as exc:
        resolve_build(tmp_path)

    assert str(exc.value) == "no Dockerfile; nothing to build"


def test_unsupported_build_is_provision_error() -> None:
    """One exception root so the CLI/conductor catch cleanly (§8)."""
    assert issubclass(UnsupportedBuild, ProvisionError)
