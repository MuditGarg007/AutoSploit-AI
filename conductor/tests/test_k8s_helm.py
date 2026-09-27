"""Tests for the M9 helm-release runner (k8s/helm.py, Phase 2).

The seam shells out to `helm` through an injectable `run` callable, so the whole
thing is proven with a fake `run` — no helm binary, no cluster. The fake captures
the argv and reads the temp values file *during* the call (the runner deletes it
afterward), so both the command shape and the serialized values are asserted. The
raise-on-failure path is covered for both a non-zero exit and a timeout.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

from autosploit_conductor.context import ConductorError
from autosploit_conductor.k8s import helm

RELEASE = "eng-abc"
NAMESPACE = "engagement-abc"
CHART = Path("/repo/deploy/helm/engagement")
VALUES = {"engagementId": "abc", "target": {"image": "reg/target:abc", "port": 8080}}


class FakeRun:
    """subprocess.run stand-in: records argv/kwargs, snapshots the --values file."""

    def __init__(self, *, returncode: int = 0, stderr: str = "", timeout: bool = False):
        self._rc = returncode
        self._stderr = stderr
        self._timeout = timeout
        self.argv: list[str] | None = None
        self.kwargs: dict | None = None
        self.values_text: str | None = None

    def __call__(self, argv, **kwargs):
        self.argv = list(argv)
        self.kwargs = kwargs
        if "--values" in self.argv:
            path = Path(self.argv[self.argv.index("--values") + 1])
            self.values_text = path.read_text(encoding="utf-8")
            assert path.exists()  # present for the duration of the call
        if self._timeout:
            raise subprocess.TimeoutExpired(cmd=self.argv, timeout=kwargs.get("timeout"))
        return subprocess.CompletedProcess(self.argv, self._rc, stdout="", stderr=self._stderr)


def test_install_argv_and_values_file():
    fake = FakeRun()
    helm.install_release(RELEASE, CHART, NAMESPACE, VALUES, run=fake, timeout_s=30.0)

    assert fake.argv[:3] == ["helm", "install", RELEASE]
    assert str(CHART) in fake.argv
    assert fake.argv[fake.argv.index("--namespace") + 1] == NAMESPACE
    assert "--create-namespace" not in fake.argv  # namespace made imperatively
    assert fake.kwargs["check"] is False
    assert fake.kwargs["timeout"] == 30.0
    # the values the conductor built round-trip through the temp file
    assert yaml.safe_load(fake.values_text) == VALUES


def test_install_values_file_removed_after_success(tmp_path, monkeypatch):
    seen: dict[str, Path] = {}

    def capture(argv, **kwargs):
        seen["path"] = Path(argv[argv.index("--values") + 1])
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    helm.install_release(RELEASE, CHART, NAMESPACE, VALUES, run=capture)
    assert not seen["path"].exists()  # cleaned up


def test_install_values_file_removed_after_failure():
    fake = FakeRun(returncode=1, stderr="boom")
    with pytest.raises(ConductorError):
        helm.install_release(RELEASE, CHART, NAMESPACE, VALUES, run=fake)
    # the snapshot path was taken during the call; it must be gone now
    path = Path(fake.argv[fake.argv.index("--values") + 1])
    assert not path.exists()


def test_install_nonzero_raises_with_stderr():
    fake = FakeRun(returncode=1, stderr="release already exists")
    with pytest.raises(ConductorError, match="release already exists"):
        helm.install_release(RELEASE, CHART, NAMESPACE, VALUES, run=fake)


def test_install_timeout_raises():
    fake = FakeRun(timeout=True)
    with pytest.raises(ConductorError, match="timed out"):
        helm.install_release(RELEASE, CHART, NAMESPACE, VALUES, run=fake, timeout_s=5.0)


def test_uninstall_argv():
    fake = FakeRun()
    helm.uninstall_release(RELEASE, NAMESPACE, run=fake)
    assert fake.argv == ["helm", "uninstall", RELEASE, "--namespace", NAMESPACE]


def test_uninstall_nonzero_raises():
    fake = FakeRun(returncode=1, stderr="not found")
    with pytest.raises(ConductorError, match="not found"):
        helm.uninstall_release(RELEASE, NAMESPACE, run=fake)


def test_uninstall_timeout_raises():
    fake = FakeRun(timeout=True)
    with pytest.raises(ConductorError, match="timed out"):
        helm.uninstall_release(RELEASE, NAMESPACE, run=fake, timeout_s=5.0)
