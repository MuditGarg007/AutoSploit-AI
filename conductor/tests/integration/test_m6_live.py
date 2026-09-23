"""M6 exit gate — the conductor's k8s controller loop on a LIVE cluster.

This is the executable form of the roadmap M6 exit criterion:

    an engagement runs entirely on the cluster — namespace created, attacker
    reaches the target over the Service DNS, report collected, namespace deleted
    with nothing left behind.

It exercises the REAL Phase B code (`EngagementCluster` + `watch_pod` + the
manifests) against a real apiserver, real gVisor Pods, and real Cilium Service
networking. The harness image (M5) and the in-cluster Kaniko target build (M8)
are separate milestones, so this uses stand-in images as legitimate placeholders:

    target   = nginx (a real web server the attacker must reach)
    attacker = curl  (reaches the target over its Service DNS, exits 0)

What is proven is exactly M6's own responsibility: the conductor stands an
engagement up on the cluster, one Pod reaches another over the Service DNS under
gVisor, the "report" (the attacker's output) is collected from the Pod, and
deleting the namespace leaves nothing behind.

The test auto-skips when no cluster is reachable, so it is inert in CI without a
cluster and runs for real on a machine with the M4 kind cluster up.
"""

from __future__ import annotations

import time
import uuid

import pytest

# Skip cleanly if the kubernetes SDK isn't installed.
pytest.importorskip("kubernetes")

from autosploit_conductor.k8s import manifests as m
from autosploit_conductor.k8s.client import EngagementCluster
from autosploit_conductor.k8s.watch import map_pod_result, watch_pod

TARGET_IMAGE = "nginx:alpine"
ATTACKER_IMAGE = "curlimages/curl:8.11.1"
TARGET_PORT = 80


def _reachable_api():
    """Return a CoreV1Api if a cluster is reachable, else None (-> skip)."""
    try:
        from autosploit_conductor.k8s.factory import build_core_v1

        api = build_core_v1()
        api.list_namespace(limit=1, _request_timeout=5)
        return api
    except Exception:  # noqa: BLE001 — any failure means "no cluster" -> skip
        return None


_API = _reachable_api()
pytestmark = pytest.mark.skipif(_API is None, reason="no reachable Kubernetes cluster")


def _namespace_exists(api, name: str) -> bool:
    from kubernetes.client.rest import ApiException

    try:
        api.read_namespace(name=name)
        return True
    except ApiException as exc:
        if exc.status == 404:
            return False
        raise


def _wait_namespace_gone(api, name: str, timeout_s: float = 120.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not _namespace_exists(api, name):
            return True
        time.sleep(2)
    return False


def test_m6_engagement_runs_and_leaves_nothing_behind():
    api = _API
    engagement_id = "live" + uuid.uuid4().hex[:8]
    cluster = EngagementCluster(api, engagement_id)
    namespace = m.namespace_name(engagement_id)

    try:
        # [1] Namespace.
        cluster.create_namespace()
        assert _namespace_exists(api, namespace)

        # [2] Target: a real web server Pod + Service, under gVisor.
        cluster.create_target_pod(TARGET_IMAGE, container_port=TARGET_PORT)
        target_dns = cluster.create_target_service(port=TARGET_PORT)
        assert target_dns == f"target.{namespace}.svc.cluster.local"

        # [3] Attacker: reach the target over its Service DNS, then exit 0. The
        # retry loop tolerates image pull + target startup (no readiness gate
        # yet — that's the provisioner's job at M8).
        probe = (
            f"for i in $(seq 1 60); do "
            f"if curl -sf http://{target_dns}:{TARGET_PORT}/ >/tmp/out 2>&1; then "
            f'echo "M6-PROBE-OK"; head -c 200 /tmp/out; exit 0; fi; '
            f"sleep 3; done; echo M6-PROBE-FAIL; exit 1"
        )
        # A Secret + ConfigMap must exist first (the attacker Pod references both).
        cluster.apply_secret("unused-in-this-probe")
        cluster.apply_configmap({"probe.txt": "m6"})
        cluster.create_attacker_pod(
            ATTACKER_IMAGE, command=["sh", "-c"], args=[probe]
        )

        # [4] Watch the attacker to completion (generous: two image pulls).
        outcome = watch_pod(
            cluster, "attacker", timeout_s=300.0, poll_interval_s=3.0
        )
        result = map_pod_result(outcome)

        # [5] Collect the "report" (the attacker's output) before teardown.
        logs = cluster.pod_logs("attacker")

        assert not outcome.timed_out, f"attacker did not finish; logs:\n{logs}"
        assert result.status == "complete", f"attacker failed; logs:\n{logs}"
        # The attacker actually reached the target over the Service DNS.
        assert "M6-PROBE-OK" in logs
        assert "nginx" in logs.lower() or "html" in logs.lower()

    finally:
        # [6] Teardown = delete the namespace. Idempotent.
        cluster.delete_namespace()

    # [7] Nothing left behind — the namespace (and everything in it) is gone.
    assert _wait_namespace_gone(api, namespace), "namespace was not fully deleted"
