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


# --- M7: the egress matrix ---------------------------------------------------


def _egress_rules(np):
    return np["spec"]["egress"]


def test_network_policy_is_cilium_and_governs_the_whole_namespace():
    # FQDN allow-listing is why this must be a CiliumNetworkPolicy, not a plain
    # k8s NetworkPolicy. The empty endpointSelector governs every Pod in the
    # engagement namespace (default-deny baseline + allow-set), so no Pod — target
    # or a probe — is left with Cilium's default-allow egress.
    np = m.network_policy_manifest(ID)
    assert np["apiVersion"] == "cilium.io/v2"
    assert np["kind"] == "CiliumNetworkPolicy"
    assert np["metadata"]["namespace"] == f"engagement-{ID}"
    assert np["spec"]["endpointSelector"] == {}


def test_network_policy_allows_dns_to_kube_dns_with_l7_rule():
    # Without an explicit DNS allow a default-deny egress blocks name resolution
    # and every other allow fails; the L7 dns rule also feeds toFQDNs.
    np = m.network_policy_manifest(ID)
    dns = _egress_rules(np)[0]
    assert dns["toEndpoints"][0]["matchLabels"] == {
        "k8s:io.kubernetes.pod.namespace": "kube-system",
        "k8s-app": "kube-dns",
    }
    ports = dns["toPorts"][0]
    protos = {p["protocol"] for p in ports["ports"]}
    assert protos == {"UDP", "TCP"}
    assert all(p["port"] == "53" for p in ports["ports"])
    assert ports["rules"]["dns"] == [{"matchPattern": "*"}]


def test_network_policy_allows_target_any_port_same_engagement():
    np = m.network_policy_manifest(ID)
    target = next(
        r
        for r in _egress_rules(np)
        if r.get("toEndpoints")
        and r["toEndpoints"][0]["matchLabels"].get("role") == "target"
    )
    assert target["toEndpoints"][0]["matchLabels"] == {
        "engagement": ID,
        "role": "target",
    }
    # Any port to the target — no toPorts restriction.
    assert "toPorts" not in target


def test_network_policy_allows_model_api_by_fqdn_on_443_only():
    np = m.network_policy_manifest(ID)
    model = next(r for r in _egress_rules(np) if "toFQDNs" in r)
    assert model["toFQDNs"] == [{"matchName": "api.openrouter.ai"}]
    port = model["toPorts"][0]["ports"][0]
    assert port == {"port": "443", "protocol": "TCP"}


def test_network_policy_allows_control_plane_ingest_on_80_only():
    np = m.network_policy_manifest(ID)
    cp = next(
        r
        for r in _egress_rules(np)
        if r.get("toEndpoints")
        and "k8s:io.kubernetes.pod.namespace" in r["toEndpoints"][0]["matchLabels"]
        and r["toEndpoints"][0]["matchLabels"].get("app") == "control-plane"
    )
    labels = cp["toEndpoints"][0]["matchLabels"]
    assert labels["k8s:io.kubernetes.pod.namespace"] == "autosploit-system"
    port = cp["toPorts"][0]["ports"][0]
    assert port == {"port": "80", "protocol": "TCP"}


def test_network_policy_denies_everything_else_by_construction():
    # The security property: exactly the four allowed edges, nothing more. Cilium
    # makes an endpoint with any egress rule default-deny, so "only these four"
    # IS the deny of Postgres/Redis/Redpanda and arbitrary internet.
    np = m.network_policy_manifest(ID)
    assert len(_egress_rules(np)) == 4


def test_network_policy_overrides_reach_control_plane_and_model():
    np = m.network_policy_manifest(
        ID,
        model_fqdns=("proxy.internal", "api.openrouter.ai"),
        control_plane_namespace="cp-ns",
        control_plane_selector={"app": "ingest"},
        control_plane_port=8080,
    )
    model = next(r for r in _egress_rules(np) if "toFQDNs" in r)
    assert model["toFQDNs"] == [
        {"matchName": "proxy.internal"},
        {"matchName": "api.openrouter.ai"},
    ]
    cp = next(
        r
        for r in _egress_rules(np)
        if r.get("toEndpoints")
        and r["toEndpoints"][0]["matchLabels"].get("app") == "ingest"
    )
    assert cp["toEndpoints"][0]["matchLabels"]["k8s:io.kubernetes.pod.namespace"] == "cp-ns"
    assert cp["toPorts"][0]["ports"][0]["port"] == "8080"
