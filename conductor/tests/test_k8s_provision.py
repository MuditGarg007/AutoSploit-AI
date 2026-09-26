"""Tests for the M8 Phase B provisioner (Kaniko in-cluster target build).

A fake cluster scripts the registry/build Pod phases so the whole provision flow —
registry up, Kaniko build, scope emit — is proven with no real cluster and no
waiting. The security-load-bearing shape (build pushes to the in-cluster registry,
image ref is the registry ref, scope points at the target Service DNS) is asserted
here; the manifest-level invariants live in test_k8s_manifests.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from autosploit_conductor.context import EngagementContext
from autosploit_conductor.k8s import manifests as m
from autosploit_conductor.k8s.provision import (
    ProvisionError,
    _kaniko_context,
    phaseb_provision,
)

ID = "eng1"
REPO = "github.com/acme/vuln-app"


def _ctx() -> EngagementContext:
    return EngagementContext(
        engagement_id=ID, out_dir=Path("."), repo_ref=REPO, timeout_s=60.0
    )


class FakeCluster:
    """Records the provision's cluster calls; scripts per-Pod phase sequences."""

    def __init__(self, phases: dict[str, list[str]], *, build_exit: int = 0) -> None:
        self.engagement_id = ID
        self.namespace = m.namespace_name(ID)
        self._phases = phases
        self._i: dict[str, int] = {}
        self._build_exit = build_exit
        self.calls: list = []

    def create_registry_pod(self) -> None:
        self.calls.append("registry_pod")

    def create_registry_service(self) -> str:
        self.calls.append("registry_service")
        return m.registry_endpoint(ID)

    def create_build_pod(self, *, context, destination, dockerfile=m.DEFAULT_DOCKERFILE):
        self.calls.append(("build_pod", context, destination, dockerfile))

    def pod_phase(self, name: str):
        seq = self._phases.get(name, ["Running"])
        i = self._i.get(name, 0)
        self._i[name] = i + 1
        return seq[min(i, len(seq) - 1)]

    def container_exit_code(self, name: str):
        return self._build_exit


def _run(cluster, **kw):
    kw.setdefault("target_port", 8080)
    return phaseb_provision(
        REPO, _ctx(), cluster, now=lambda: 0.0, sleep=lambda s: None, **kw
    )


def test_happy_path_builds_and_returns_registry_image():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    prov = _run(cluster)

    # Registry stood up before the build pushed to it.
    assert cluster.calls[0] == "registry_pod"
    assert cluster.calls[1] == "registry_service"
    kind, context, destination, dockerfile = cluster.calls[2]
    assert kind == "build_pod"
    # Kaniko pushes to, and the target runs from, the in-cluster registry ref.
    assert destination == f"registry.engagement-{ID}.svc:5000/target:latest"
    assert prov.target_image == destination
    assert prov.target_port == 8080
    assert context == f"git://{REPO}"
    assert dockerfile == "Dockerfile"


def test_scope_points_at_target_service_dns_and_port():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    prov = _run(cluster)
    scope = prov.config_files["scope.yaml"]
    assert f"host: {m.target_service_dns(ID)}" in scope
    assert "ports: [8080]" in scope
    # run.toml is emitted and names the sibling scope file.
    assert 'scope_file = "scope.yaml"' in prov.config_files["run.toml"]


def test_service_port_overrides_the_scope_port_not_the_target_port():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    prov = _run(cluster, service_port=80)
    assert "ports: [80]" in prov.config_files["scope.yaml"]  # attacker dials 80
    assert prov.target_port == 8080  # container still listens on 8080
    assert prov.service_port == 80


def test_registry_not_ready_is_provision_error():
    cluster = FakeCluster({"registry": ["Failed"], "build": ["Succeeded"]})
    with pytest.raises(ProvisionError, match="registry"):
        _run(cluster)
    # Build is never attempted if the registry never came up.
    assert not any(isinstance(c, tuple) and c[0] == "build_pod" for c in cluster.calls)


def test_build_failure_is_provision_error():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Failed"]}, build_exit=1)
    with pytest.raises(ProvisionError, match="kaniko build failed"):
        _run(cluster)


def test_build_timeout_is_provision_error():
    # Never terminal: watch_pod times out. FakeClock-free: real now/sleep injected
    # via _run would loop, so drive a clock that trips the deadline immediately.
    cluster = FakeCluster({"registry": ["Running"], "build": ["Running"]})
    clock = {"t": 0.0}

    def now():
        clock["t"] += 100.0
        return clock["t"]

    with pytest.raises(ProvisionError, match="timed out"):
        phaseb_provision(
            REPO, _ctx(), cluster, target_port=8080,
            build_timeout_s=1.0, now=now, sleep=lambda s: None,
        )


def test_kaniko_context_prefixes_bare_ref_but_passes_scheme_through():
    assert _kaniko_context("github.com/acme/app") == "git://github.com/acme/app"
    assert _kaniko_context("git://github.com/acme/app#main") == "git://github.com/acme/app#main"
    assert _kaniko_context("https://x/y.git") == "https://x/y.git"
