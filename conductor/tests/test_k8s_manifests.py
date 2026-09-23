"""Tests for the pure k8s manifest builders (M6 step 1).

The gate for step 1: the builders produce valid-shaped objects AND hold the three
security-load-bearing invariants (gVisor on every Pod, run-once restart policy,
key only ever by Secret reference) so the API layers can trust them.
"""

from __future__ import annotations

import json

from autosploit_conductor.k8s import manifests as m

ID = "eng_abc.123-XYZ"


def test_namespace_name_and_dns():
    assert m.namespace_name(ID) == f"engagement-{ID}"
    assert m.target_service_dns(ID) == f"target.engagement-{ID}.svc.cluster.local"


def test_engagement_labels():
    assert m.engagement_labels(ID) == {"engagement": ID}
    assert m.engagement_labels(ID, role="target") == {"engagement": ID, "role": "target"}


def test_namespace_manifest_shape():
    ns = m.namespace_manifest(ID)
    assert ns["kind"] == "Namespace"
    assert ns["metadata"]["name"] == f"engagement-{ID}"
    assert ns["metadata"]["labels"]["engagement"] == ID


def test_secret_carries_key_in_stringdata_only():
    key = "sk-or-v1-deadbeefdeadbeef"
    sec = m.secret_manifest(ID, key)
    assert sec["kind"] == "Secret"
    assert sec["type"] == "Opaque"
    assert sec["metadata"]["namespace"] == f"engagement-{ID}"
    # The key value lives here, and only here.
    assert sec["stringData"]["OPENROUTER_API_KEY"] == key


def test_configmap_holds_run_files():
    cm = m.configmap_manifest(ID, {"scope.yaml": "target: {}", "run.toml": "[model]\n"})
    assert cm["kind"] == "ConfigMap"
    assert cm["data"]["scope.yaml"] == "target: {}"
    assert cm["data"]["run.toml"] == "[model]\n"


def test_attacker_pod_runs_under_gvisor_once():
    pod = m.attacker_pod_manifest(ID, "ghcr.io/x/harness:abc")
    assert pod["spec"]["runtimeClassName"] == "gvisor"
    assert pod["spec"]["restartPolicy"] == "Never"
    assert pod["metadata"]["labels"]["role"] == "attacker"


def test_attacker_pod_gets_key_by_reference_never_plaintext():
    key = "sk-or-v1-THIS_MUST_NOT_APPEAR"
    pod = m.attacker_pod_manifest(ID, "ghcr.io/x/harness:abc")

    env = pod["spec"]["containers"][0]["env"]
    key_env = next(e for e in env if e["name"] == "OPENROUTER_API_KEY")
    # Delivered by secretKeyRef, with no inline value.
    assert key_env["valueFrom"]["secretKeyRef"] == {
        "name": "model-key",
        "key": "OPENROUTER_API_KEY",
    }
    assert "value" not in key_env

    # Belt + braces: the raw key can never be serialized into the Pod spec, so
    # `kubectl get pod -o yaml` can't leak it. (The key isn't even an input to
    # the Pod builder — this asserts the contract stays that way.)
    assert key not in json.dumps(pod)


def test_attacker_default_args_are_harness_cli():
    pod = m.attacker_pod_manifest(ID, "img")
    container = pod["spec"]["containers"][0]
    assert "command" not in container  # image entrypoint (the harness) is used
    assert container["args"] == ["run", "--config", "/etc/autosploit/run.toml"]


def test_attacker_command_and_args_override():
    pod = m.attacker_pod_manifest(
        ID, "curlimages/curl", command=["sh", "-c"], args=["curl -sf http://target"]
    )
    container = pod["spec"]["containers"][0]
    assert container["command"] == ["sh", "-c"]
    assert container["args"] == ["curl -sf http://target"]
    # Overriding the entrypoint doesn't weaken isolation or key delivery.
    assert pod["spec"]["runtimeClassName"] == "gvisor"
    assert container["env"][0]["valueFrom"]["secretKeyRef"]["name"] == "model-key"


def test_attacker_mounts_run_config_and_points_at_it():
    pod = m.attacker_pod_manifest(ID, "img")
    container = pod["spec"]["containers"][0]
    assert container["args"] == ["run", "--config", "/etc/autosploit/run.toml"]
    mount = container["volumeMounts"][0]
    assert mount["mountPath"] == "/etc/autosploit"
    assert mount["readOnly"] is True
    vol = pod["spec"]["volumes"][0]
    assert vol["configMap"]["name"] == "run-config"


def test_target_pod_isolated_no_key_no_config():
    pod = m.target_pod_manifest(ID, "img:built", container_port=3000)
    assert pod["spec"]["runtimeClassName"] == "gvisor"
    assert pod["spec"]["restartPolicy"] == "Never"
    container = pod["spec"]["containers"][0]
    # Target is untrusted user code: no env, no secret, no config mount.
    assert "env" not in container
    assert "volumeMounts" not in container
    assert container["ports"][0]["containerPort"] == 3000


def test_service_selects_target_and_maps_ports():
    svc = m.target_service_manifest(ID, port=80, target_port=3000)
    assert svc["kind"] == "Service"
    assert svc["spec"]["selector"] == {"engagement": ID, "role": "target"}
    p = svc["spec"]["ports"][0]
    assert p["port"] == 80
    assert p["targetPort"] == 3000


def test_service_target_port_defaults_to_port():
    svc = m.target_service_manifest(ID, port=8080)
    assert svc["spec"]["ports"][0]["targetPort"] == 8080
