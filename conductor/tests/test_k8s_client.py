"""Tests for the EngagementCluster client wrapper (M6 step 2).

Driven entirely by a fake CoreV1Api — no live cluster. The fake records every
call and can raise ApiException-shaped errors (an int `.status`) so the two
idempotency rules (409 on create-namespace, 404 on delete-namespace) are proven
deterministically.
"""

from __future__ import annotations

import pytest

from autosploit_conductor.k8s.client import EngagementCluster

ID = "eng1"
NS = "engagement-eng1"


class FakeApiException(Exception):
    """Stand-in for kubernetes.client.rest.ApiException — carries an int status."""

    def __init__(self, status: int) -> None:
        super().__init__(f"api error {status}")
        self.status = status


class FakeCoreV1:
    """Records calls; models namespace existence for the idempotency rules."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._namespaces: set[str] = set()
        self.pods: dict[str, dict] = {}  # name -> pod object (dict)
        self.logs: dict[str, str] = {}

    def create_namespace(self, body):
        self.calls.append(("create_namespace", {"body": body}))
        name = body["metadata"]["name"]
        if name in self._namespaces:
            raise FakeApiException(409)
        self._namespaces.add(name)

    def delete_namespace(self, name):
        self.calls.append(("delete_namespace", {"name": name}))
        if name not in self._namespaces:
            raise FakeApiException(404)
        self._namespaces.discard(name)

    def create_namespaced_secret(self, namespace, body):
        self.calls.append(("create_namespaced_secret", {"namespace": namespace, "body": body}))

    def create_namespaced_config_map(self, namespace, body):
        self.calls.append(("create_namespaced_config_map", {"namespace": namespace, "body": body}))

    def create_namespaced_pod(self, namespace, body):
        self.calls.append(("create_namespaced_pod", {"namespace": namespace, "body": body}))

    def create_namespaced_service(self, namespace, body):
        self.calls.append(("create_namespaced_service", {"namespace": namespace, "body": body}))

    def create_namespaced_custom_object(self, group, version, namespace, plural, body):
        self.calls.append(
            (
                "create_namespaced_custom_object",
                {
                    "group": group,
                    "version": version,
                    "namespace": namespace,
                    "plural": plural,
                    "body": body,
                },
            )
        )

    def read_namespaced_pod(self, name, namespace):
        self.calls.append(("read_namespaced_pod", {"name": name, "namespace": namespace}))
        return self.pods[name]

    def read_namespaced_pod_log(self, name, namespace):
        self.calls.append(("read_namespaced_pod_log", {"name": name, "namespace": namespace}))
        return self.logs.get(name, "")


def _kinds(api: FakeCoreV1) -> list[str]:
    return [name for name, _ in api.calls]


def test_create_namespace_records_call():
    api = FakeCoreV1()
    EngagementCluster(api, ID).create_namespace()
    assert _kinds(api) == ["create_namespace"]
    assert api.calls[0][1]["body"]["metadata"]["name"] == NS


def test_create_namespace_idempotent_on_409():
    api = FakeCoreV1()
    c = EngagementCluster(api, ID)
    c.create_namespace()
    # Second create hits a 409 and must be swallowed, not raised.
    c.create_namespace()
    assert _kinds(api).count("create_namespace") == 2


def test_delete_namespace_idempotent_on_404():
    api = FakeCoreV1()
    c = EngagementCluster(api, ID)
    # Deleting a namespace that was never created is a no-op, not an error.
    c.delete_namespace()
    c.create_namespace()
    c.delete_namespace()
    c.delete_namespace()  # already gone again -> still fine
    assert _kinds(api).count("delete_namespace") == 3


def test_non_idempotency_error_is_reraised():
    api = FakeCoreV1()

    def boom(body):
        raise FakeApiException(500)

    api.create_namespace = boom  # type: ignore[method-assign]
    with pytest.raises(FakeApiException):
        EngagementCluster(api, ID).create_namespace()


def test_plain_exception_is_not_swallowed():
    api = FakeCoreV1()

    def boom(name):
        raise ValueError("not an api error")

    api.delete_namespace = boom  # type: ignore[method-assign]
    with pytest.raises(ValueError):
        EngagementCluster(api, ID).delete_namespace()


def test_apply_secret_and_configmap_target_namespace():
    api = FakeCoreV1()
    c = EngagementCluster(api, ID)
    c.apply_secret("sk-or-v1-key")
    c.apply_configmap({"scope.yaml": "target: {}", "run.toml": "[model]\n"})

    sec = next(kw for name, kw in api.calls if name == "create_namespaced_secret")
    assert sec["namespace"] == NS
    assert sec["body"]["stringData"]["OPENROUTER_API_KEY"] == "sk-or-v1-key"

    cm = next(kw for name, kw in api.calls if name == "create_namespaced_config_map")
    assert cm["body"]["data"]["run.toml"] == "[model]\n"


def test_create_attacker_pod_uses_pod_api_in_namespace():
    api = FakeCoreV1()
    EngagementCluster(api, ID).create_attacker_pod("ghcr.io/x/harness:abc")
    pod = next(kw for name, kw in api.calls if name == "create_namespaced_pod")
    assert pod["namespace"] == NS
    assert pod["body"]["metadata"]["labels"]["role"] == "attacker"
    assert pod["body"]["spec"]["containers"][0]["image"] == "ghcr.io/x/harness:abc"


def test_apply_network_policy_creates_cilium_crd_in_namespace():
    api = FakeCoreV1()
    EngagementCluster(api, ID).apply_network_policy()
    call = next(
        kw for name, kw in api.calls if name == "create_namespaced_custom_object"
    )
    assert call["group"] == "cilium.io"
    assert call["version"] == "v2"
    assert call["plural"] == "ciliumnetworkpolicies"
    assert call["namespace"] == NS
    assert call["body"]["kind"] == "CiliumNetworkPolicy"
    assert call["body"]["spec"]["endpointSelector"] == {}


def test_apply_network_policy_uses_injected_custom_api():
    # When a separate CustomObjectsApi is injected, the CRD goes there, not to the
    # CoreV1 api (mirrors production: CoreV1Api + CustomObjectsApi are distinct).
    core = FakeCoreV1()
    custom = FakeCoreV1()
    EngagementCluster(core, ID, custom=custom).apply_network_policy()
    assert any(n == "create_namespaced_custom_object" for n in _kinds(custom))
    assert not any(n == "create_namespaced_custom_object" for n in _kinds(core))


def test_create_build_pod_uses_pod_api_with_kaniko_args():
    api = FakeCoreV1()
    EngagementCluster(api, ID).create_build_pod(
        context="git://github.com/acme/vuln-app#main",
        destination="reg/target:latest",
    )
    pod = next(kw for name, kw in api.calls if name == "create_namespaced_pod")
    assert pod["namespace"] == NS
    assert pod["body"]["metadata"]["labels"]["role"] == "build"
    args = pod["body"]["spec"]["containers"][0]["args"]
    assert "--context=git://github.com/acme/vuln-app#main" in args
    assert "--destination=reg/target:latest" in args


def test_create_registry_pod_and_service_return_endpoint():
    api = FakeCoreV1()
    c = EngagementCluster(api, ID)
    c.create_registry_pod()
    endpoint = c.create_registry_service()
    assert endpoint == "registry.engagement-eng1.svc:5000"
    pod = next(kw for name, kw in api.calls if name == "create_namespaced_pod")
    assert pod["body"]["metadata"]["labels"]["role"] == "registry"
    assert pod["namespace"] == NS
    svc = next(kw for name, kw in api.calls if name == "create_namespaced_service")
    assert svc["body"]["spec"]["ports"][0]["port"] == 5000


def test_create_target_service_returns_cluster_dns():
    api = FakeCoreV1()
    dns = EngagementCluster(api, ID).create_target_service(port=80, target_port=3000)
    assert dns == "target.engagement-eng1.svc.cluster.local"
    svc = next(kw for name, kw in api.calls if name == "create_namespaced_service")
    assert svc["body"]["spec"]["ports"][0]["targetPort"] == 3000


def test_pod_phase_reads_dict_status():
    api = FakeCoreV1()
    api.pods["attacker"] = {"status": {"phase": "Succeeded"}}
    assert EngagementCluster(api, ID).pod_phase("attacker") == "Succeeded"


def test_pod_phase_reads_object_status():
    api = FakeCoreV1()

    class _Status:
        phase = "Running"

    class _Pod:
        status = _Status()

    api.pods["attacker"] = _Pod()  # type: ignore[assignment]
    assert EngagementCluster(api, ID).pod_phase("attacker") == "Running"


def test_pod_phase_none_when_unreadable():
    api = FakeCoreV1()
    api.pods["attacker"] = {"metadata": {}}  # no status yet
    assert EngagementCluster(api, ID).pod_phase("attacker") is None


def test_pod_logs_returns_text():
    api = FakeCoreV1()
    api.logs["attacker"] = "turn 1: recon\nturn 2: exploit\n"
    assert "exploit" in EngagementCluster(api, ID).pod_logs("attacker")


def test_container_exit_code_from_dict():
    api = FakeCoreV1()
    api.pods["attacker"] = {
        "status": {"containerStatuses": [{"state": {"terminated": {"exitCode": 2}}}]}
    }
    assert EngagementCluster(api, ID).container_exit_code("attacker") == 2


def test_container_exit_code_none_when_not_terminated():
    api = FakeCoreV1()
    api.pods["attacker"] = {"status": {"containerStatuses": [{"state": {"running": {}}}]}}
    assert EngagementCluster(api, ID).container_exit_code("attacker") is None
