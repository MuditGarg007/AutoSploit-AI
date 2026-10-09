"""Tests for the Phase B provisioner (Kaniko in-cluster build + M5 repo/base mirror).

A fake cluster scripts the registry/build Pod phases, and injected fake clone/mirror
seams stand in for `resolve_source`/`crane copy`, so the whole provision flow — registry
up, conductor-side clone, base-image mirror, `dir://` context ConfigMap, Kaniko build,
scope emit — is proven with no real cluster, no git, no crane, and no waiting. The
security-load-bearing shape (build fetches its context in-cluster, bases resolve against
the mirror, nothing needs egress, image ref is the registry ref, scope points at the
target Service DNS) is asserted here; the manifest-level invariants live in
test_k8s_manifests.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from autosploit_provisioner.contracts.plan import Source

from autosploit_conductor.context import EngagementContext
from autosploit_conductor.k8s import manifests as m
from autosploit_conductor.k8s.provision import (
    ProvisionError,
    _external_bases,
    _mirror_dst,
    phaseb_provision,
)

ID = "eng1"
REPO = "github.com/acme/vuln-app"
_DOCKERFILE = "FROM busybox:1.36\nCOPY app.py /\n"


def _ctx() -> EngagementContext:
    return EngagementContext(
        engagement_id=ID, out_dir=Path("."), repo_ref=REPO, timeout_s=60.0
    )


class FakeCluster:
    """Records the provision's cluster calls; scripts per-Pod phase sequences."""

    def __init__(
        self,
        phases: dict[str, list[str]],
        *,
        build_exit: int = 0,
        build_logs: str | None = None,
    ) -> None:
        self.engagement_id = ID
        self.namespace = m.namespace_name(ID)
        self._phases = phases
        self._i: dict[str, int] = {}
        self._build_exit = build_exit
        self._build_logs = build_logs
        self.calls: list = []
        self.context_files: dict[str, str] | None = None

    def create_registry_pod(self) -> None:
        self.calls.append("registry_pod")

    def create_registry_service(self) -> str:
        self.calls.append("registry_service")
        return m.registry_endpoint(ID)

    def apply_build_egress_policy(self) -> None:
        self.calls.append("build_egress")

    def create_build_context_configmap(self, files, *, name=m.BUILD_CONTEXT_CONFIGMAP):
        self.calls.append(("build_context", dict(files)))
        self.context_files = dict(files)
        return name

    def create_build_pod(
        self,
        *,
        context,
        destination,
        dockerfile=m.DEFAULT_DOCKERFILE,
        context_configmap=None,
        context_files=None,
        registry_mirror=None,
    ):
        self.calls.append(
            ("build_pod", context, destination, dockerfile, context_configmap, registry_mirror)
        )
        self.build_context_files = context_files

    def pod_phase(self, name: str):
        seq = self._phases.get(name, ["Running"])
        i = self._i.get(name, 0)
        self._i[name] = i + 1
        return seq[min(i, len(seq) - 1)]

    def container_exit_code(self, name: str):
        return self._build_exit

    def pod_logs(self, name: str) -> str:
        if self._build_logs is None:
            raise RuntimeError(f"no logs for {name} (Pod gone)")
        return self._build_logs


def _fake_clone(dockerfile: str = _DOCKERFILE, *, extra: dict[str, str] | None = None):
    """A resolve_fn that writes a repo into the workdir and records the ref it got."""
    seen: dict[str, str] = {}

    def resolve(ref: str, workdir: Path) -> Source:
        seen["ref"] = ref
        workdir.mkdir(parents=True, exist_ok=True)
        (workdir / "Dockerfile").write_text(dockerfile)
        (workdir / "app.py").write_text("print('hi')\n")
        for rel, content in (extra or {}).items():
            p = workdir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        return Source(kind="git", path=workdir, image_ref=None, commit="deadbeef")

    resolve.seen = seen  # type: ignore[attr-defined]
    return resolve


def _mirror_recorder():
    calls: list[tuple[str, str]] = []

    def mirror(src: str, dst: str) -> None:
        calls.append((src, dst))

    mirror.calls = calls  # type: ignore[attr-defined]
    return mirror


def _run(cluster, *, resolve_fn=None, mirror_fn=None, **kw):
    kw.setdefault("target_port", 8080)
    return phaseb_provision(
        REPO,
        _ctx(),
        cluster,
        now=lambda: 0.0,
        sleep=lambda s: None,
        resolve_fn=resolve_fn or _fake_clone(),
        mirror_fn=mirror_fn or _mirror_recorder(),
        **kw,
    )


def test_happy_path_clones_mirrors_and_builds_via_dir_context():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    resolve_fn = _fake_clone()
    mirror_fn = _mirror_recorder()
    prov = _run(cluster, resolve_fn=resolve_fn, mirror_fn=mirror_fn)

    # Flow: registry up → context ConfigMap packed → build Pod. (Clone + mirror happen
    # conductor-side, off the cluster; asserted via the recorders below.)
    assert [c if isinstance(c, str) else c[0] for c in cluster.calls] == [
        "registry_pod",
        "registry_service",
        "build_context",
        "build_egress",
        "build_pod",
    ]

    # The conductor cloned an https remote (bare ref would misread as an image ref).
    assert resolve_fn.seen["ref"] == f"https://{REPO}"

    # The external base was preloaded into the in-cluster mirror at the path the
    # `--registry-mirror` will look for it.
    mirror = m.registry_mirror_endpoint(ID)
    assert mirror_fn.calls == [("busybox:1.36", f"{mirror}/library/busybox:1.36")]

    # The packed context holds the repo files (Dockerfile + source), no `.git`.
    assert cluster.context_files is not None
    assert cluster.context_files["Dockerfile"] == _DOCKERFILE
    assert "app.py" in cluster.context_files

    # The build Pod is told the context keys so the manifest can mount each by
    # subPath (no atomic-writer symlink that breaks Kaniko COPY/RUN).
    assert cluster.build_context_files is not None
    assert set(cluster.build_context_files) == set(cluster.context_files)

    # The build Pod uses a `dir://` context from that ConfigMap + the mirror — never
    # a `git://` external context (which the live egress would deny).
    build_pod = next(
        c for c in cluster.calls if isinstance(c, tuple) and c[0] == "build_pod"
    )
    (_, context, destination, dockerfile, context_cm, registry_mirror) = build_pod
    assert context == f"dir://{m.BUILD_CONTEXT_MOUNT}"
    assert not context.startswith("git://")
    assert context_cm == m.BUILD_CONTEXT_CONFIGMAP
    assert registry_mirror == mirror
    assert destination == f"registry.engagement-{ID}.svc:5000/target:latest"
    assert prov.target_image == destination
    assert prov.target_port == 8080
    assert dockerfile == "Dockerfile"


def test_build_gate_wraps_only_the_build_steps():
    """The gate (lever A2) is entered before the build steps and exited after, and
    only the clone/mirror/Kaniko calls happen while it is held — not registry setup
    (before) or scope emit (after)."""
    import contextlib

    events: list = []

    @contextlib.contextmanager
    def gate_fn():
        events.append("gate_enter")
        try:
            yield
        finally:
            events.append("gate_exit")

    class TracingCluster(FakeCluster):
        def create_registry_pod(self) -> None:
            events.append("registry_pod")
            super().create_registry_pod()

        def create_build_context_configmap(self, files, *, name=m.BUILD_CONTEXT_CONFIGMAP):
            events.append("build_context")
            return super().create_build_context_configmap(files, name=name)

        def create_build_pod(self, **kw):
            events.append("build_pod")
            super().create_build_pod(**kw)

    cluster = TracingCluster({"registry": ["Running"], "build": ["Succeeded"]})
    _run(cluster, gate_fn=gate_fn)

    # registry setup is outside the gate; clone/mirror/build are inside; the gate
    # closes before scope emit.
    assert events.index("registry_pod") < events.index("gate_enter")
    assert events.index("gate_enter") < events.index("build_context") < events.index("build_pod")
    assert events.index("build_pod") < events.index("gate_exit")


def test_build_gate_released_on_build_failure():
    """A failed build still exits the gate (context manager), freeing the slot."""
    import contextlib

    released = []

    @contextlib.contextmanager
    def gate_fn():
        try:
            yield
        finally:
            released.append(True)

    cluster = FakeCluster({"registry": ["Running"], "build": ["Failed"]}, build_exit=1)
    with pytest.raises(ProvisionError):
        _run(cluster, gate_fn=gate_fn)
    assert released == [True]  # slot freed despite the failure


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
    # Neither the clone nor the build is attempted if the registry never came up.
    assert not any(
        isinstance(c, tuple) and c[0] in ("build_context", "build_pod")
        for c in cluster.calls
    )


def test_build_failure_is_provision_error():
    cluster = FakeCluster({"registry": ["Running"], "build": ["Failed"]}, build_exit=1)
    with pytest.raises(ProvisionError, match="kaniko build failed"):
        _run(cluster)


def test_build_failure_appends_build_log_tail():
    # The real Kaniko stderr is captured into the ProvisionError before teardown
    # deletes the namespace, so conductor.json records the actual cause.
    logs = "pulling base...\nRUN pip install -r requirements.txt\nConnection timed out"
    cluster = FakeCluster(
        {"registry": ["Running"], "build": ["Failed"]}, build_exit=1, build_logs=logs
    )
    with pytest.raises(ProvisionError, match="Connection timed out") as exc:
        _run(cluster)
    assert "kaniko build failed" in str(exc.value)
    assert "RUN pip install -r requirements.txt" in str(exc.value)


def test_build_failure_log_fetch_error_does_not_mask_failure():
    # pod_logs raising (Pod already torn down) must not eclipse the build failure.
    cluster = FakeCluster(
        {"registry": ["Running"], "build": ["Failed"]}, build_exit=1, build_logs=None
    )
    with pytest.raises(ProvisionError, match="kaniko build failed"):
        _run(cluster)


def test_build_timeout_is_provision_error():
    # Never terminal: watch_pod times out. Drive a clock that trips the deadline.
    cluster = FakeCluster({"registry": ["Running"], "build": ["Running"]})
    clock = {"t": 0.0}

    def now():
        clock["t"] += 100.0
        return clock["t"]

    with pytest.raises(ProvisionError, match="timed out"):
        phaseb_provision(
            REPO, _ctx(), cluster, target_port=8080,
            build_timeout_s=1.0, now=now, sleep=lambda s: None,
            resolve_fn=_fake_clone(), mirror_fn=_mirror_recorder(),
        )


def test_oversize_context_fails_closed():
    # A repo whose packed context blows the 1 MiB ConfigMap ceiling fails closed,
    # before any build Pod is launched.
    big = "x" * (1024 * 1024 + 1)
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    with pytest.raises(ProvisionError, match="ceiling"):
        _run(cluster, resolve_fn=_fake_clone(extra={"big.txt": big}))
    assert not any(isinstance(c, tuple) and c[0] == "build_pod" for c in cluster.calls)


def test_mirror_failure_fails_closed():
    # A base-image copy that fails surfaces as a clean ProvisionError, not a crash,
    # and no build Pod is launched.
    def boom(src, dst):
        raise RuntimeError("crane exploded")

    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    with pytest.raises(ProvisionError, match="preparation failed"):
        _run(cluster, mirror_fn=boom)
    assert not any(isinstance(c, tuple) and c[0] == "build_pod" for c in cluster.calls)


def test_dir_context_ref_passes_through_without_clone_or_mirror():
    # A ref that already names an in-cluster `dir://` context skips the clone/mirror
    # path entirely (no ConfigMap created here; the caller staged it).
    cluster = FakeCluster({"registry": ["Running"], "build": ["Succeeded"]})
    resolve_fn = _fake_clone()
    mirror_fn = _mirror_recorder()
    phaseb_provision(
        "dir:///workspace", _ctx(), cluster, target_port=8080,
        now=lambda: 0.0, sleep=lambda s: None,
        resolve_fn=resolve_fn, mirror_fn=mirror_fn,
    )
    assert "ref" not in resolve_fn.seen
    assert mirror_fn.calls == []
    build_pod = next(
        c for c in cluster.calls if isinstance(c, tuple) and c[0] == "build_pod"
    )
    (_, context, _dest, _df, context_cm, registry_mirror) = build_pod
    assert context == "dir:///workspace"
    assert context_cm is None and registry_mirror is None


def test_external_bases_skips_scratch_stages_and_args():
    dockerfile = (
        "FROM busybox:1.36 AS build\n"
        "RUN echo hi\n"
        "FROM scratch\n"
        "FROM build\n"  # a prior stage — not an external pull
        "FROM ghcr.io/acme/base:1\n"
        "FROM $DYNAMIC\n"
        "FROM busybox:1.36\n"  # duplicate of the first — de-duplicated
    )
    tmp = Path(tempfile.mkdtemp())
    (tmp / "Dockerfile").write_text(dockerfile)
    assert _external_bases(tmp / "Dockerfile") == ["busybox:1.36", "ghcr.io/acme/base:1"]


def test_external_bases_missing_dockerfile_fails_closed():
    tmp = Path(tempfile.mkdtemp())
    with pytest.raises(ProvisionError, match="Dockerfile"):
        _external_bases(tmp / "Dockerfile")


def test_mirror_dst_normalizes_host_tag_and_digest():
    mirror = "registry.engagement-eng1.svc:5000"
    # docker-hub short name gains `library/` and defaults to `:latest`
    assert _mirror_dst("busybox", mirror) == f"{mirror}/library/busybox:latest"
    assert _mirror_dst("busybox:1.36", mirror) == f"{mirror}/library/busybox:1.36"
    # docker-hub user/repo keeps its path
    assert _mirror_dst("acme/app:2", mirror) == f"{mirror}/acme/app:2"
    # explicit registry host is dropped (mirror swaps the host)
    assert _mirror_dst("ghcr.io/org/img:tag", mirror) == f"{mirror}/org/img:tag"
    # host with a port is recognized as a host, not a tag
    assert _mirror_dst("reg.io:5000/org/img", mirror) == f"{mirror}/org/img:latest"
    # digest suffix is preserved
    assert (
        _mirror_dst("ghcr.io/org/img@sha256:abc", mirror)
        == f"{mirror}/org/img@sha256:abc"
    )
