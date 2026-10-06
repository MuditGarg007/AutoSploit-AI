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


# --- M8: the Kaniko in-cluster target build ----------------------------------


def _build_pod():
    return m.kaniko_build_pod_manifest(
        ID,
        context="git://github.com/acme/vuln-app#refs/heads/main",
        destination="registry.engagement.svc/target:latest",
    )


def test_build_pod_runs_kaniko_once_under_gvisor():
    pod = _build_pod()
    assert pod["kind"] == "Pod"
    assert pod["metadata"]["namespace"] == f"engagement-{ID}"
    assert pod["metadata"]["labels"] == {"engagement": ID, "role": "build"}
    # Same engagement invariants as every other Pod: jailed, run exactly once.
    assert pod["spec"]["runtimeClassName"] == "gvisor"
    assert pod["spec"]["restartPolicy"] == "Never"


def test_build_pod_passes_context_dockerfile_destination_to_kaniko():
    pod = _build_pod()
    container = pod["spec"]["containers"][0]
    assert container["image"] == m.KANIKO_IMAGE
    assert container["args"] == [
        "--context=git://github.com/acme/vuln-app#refs/heads/main",
        "--dockerfile=Dockerfile",
        "--destination=registry.engagement.svc/target:latest",
        # Push to the in-cluster HTTP registry (no TLS) — load-bearing for M8.
        "--insecure",
    ]


def test_build_pod_dockerfile_and_image_overridable():
    pod = m.kaniko_build_pod_manifest(
        ID,
        context="dir:///workspace",
        destination="reg/target:1",
        dockerfile="docker/Prod.Dockerfile",
        image="gcr.io/kaniko-project/executor@sha256:deadbeef",
    )
    container = pod["spec"]["containers"][0]
    assert container["image"] == "gcr.io/kaniko-project/executor@sha256:deadbeef"
    assert "--dockerfile=docker/Prod.Dockerfile" in container["args"]


def test_build_pod_has_no_docker_socket_no_hostpath_no_privilege():
    # The whole reason to build with Kaniko: no daemon, no socket, no host mount,
    # no privilege — so untrusted repo content can never reach the node (roadmap M8
    # exit). Kaniko is root INSIDE its container by design, so this is deliberately
    # not runAsNonRoot; isolation is gVisor + the absence of any of the below.
    pod = _build_pod()
    spec = pod["spec"]
    assert "volumes" not in spec
    container = spec["containers"][0]
    assert "volumeMounts" not in container
    sc = container.get("securityContext", {})
    assert sc.get("privileged") is not True
    # No docker socket / host path smuggled in anywhere in the serialized spec.
    blob = json.dumps(pod)
    assert "docker.sock" not in blob
    assert "hostPath" not in blob


def test_build_pod_mounts_in_cluster_context_configmap_readonly():
    # The M8 live-proof path: supply the build context from an in-cluster ConfigMap
    # (paired with a dir:// context) so Kaniko needs no external egress under the
    # M7 default-deny matrix. A ConfigMap volume is API data, not a host mount.
    pod = m.kaniko_build_pod_manifest(
        ID,
        context=f"dir://{m.BUILD_CONTEXT_MOUNT}",
        destination="reg/target:1",
        context_configmap="build-context",
    )
    spec = pod["spec"]
    vol = spec["volumes"][0]
    assert vol["configMap"]["name"] == "build-context"
    mount = spec["containers"][0]["volumeMounts"][0]
    assert mount["name"] == vol["name"]
    assert mount["mountPath"] == m.BUILD_CONTEXT_MOUNT
    assert mount["readOnly"] is True
    # Still no host mount / socket / privilege — the invariant holds with a context.
    blob = json.dumps(pod)
    assert "hostPath" not in blob
    assert "docker.sock" not in blob


# --- M5: the in-cluster repo/base mirror -------------------------------------


def test_kaniko_image_is_digest_pinned():
    # The --registry-mirror behaviour Phase 5 relies on is version-sensitive, so the
    # executor must be pinned by digest, never a floating tag.
    assert "@sha256:" in m.KANIKO_IMAGE


def test_build_context_configmap_shape():
    cm = m.build_context_configmap_manifest(
        ID, {"Dockerfile": "FROM busybox:1.36\n", "app/main.py": "print('x')\n"}
    )
    assert cm["kind"] == "ConfigMap"
    assert cm["metadata"]["name"] == "build-context"
    assert cm["metadata"]["namespace"] == f"engagement-{ID}"
    assert cm["metadata"]["labels"] == {"engagement": ID}
    assert cm["data"]["Dockerfile"] == "FROM busybox:1.36\n"
    assert cm["data"]["app/main.py"] == "print('x')\n"


def test_build_context_configmap_name_overridable_and_copies_files():
    files = {"Dockerfile": "FROM scratch\n"}
    cm = m.build_context_configmap_manifest(ID, files, name="ctx-2")
    assert cm["metadata"]["name"] == "ctx-2"
    # The builder copies the mapping — mutating the caller's dict must not leak in.
    files["Dockerfile"] = "tampered"
    assert cm["data"]["Dockerfile"] == "FROM scratch\n"


def test_registry_mirror_endpoint_is_the_engagement_registry():
    assert m.registry_mirror_endpoint(ID) == m.registry_endpoint(ID)


def test_kaniko_pod_has_registry_mirror_args():
    # The mirror path (M5): external FROM bases resolve against the in-cluster mirror
    # over plain HTTP with no fallback to the (egress-denied) external registry.
    mirror = m.registry_mirror_endpoint(ID)
    pod = m.kaniko_build_pod_manifest(
        ID,
        context=f"dir://{m.BUILD_CONTEXT_MOUNT}",
        destination="reg/target:1",
        context_configmap="build-context",
        registry_mirror=mirror,
    )
    args = pod["spec"]["containers"][0]["args"]
    assert f"--registry-mirror={mirror}" in args
    assert "--insecure-pull" in args
    assert "--skip-default-registry-fallback" in args
    # Push-side --insecure is independent and still present.
    assert "--insecure" in args
    # Mirror args are opt-in: absent when registry_mirror is not passed.
    plain = m.kaniko_build_pod_manifest(ID, context="git://h/o/r#m", destination="d")
    plain_args = plain["spec"]["containers"][0]["args"]
    assert not any(a.startswith("--registry-mirror=") for a in plain_args)
    assert "--insecure-pull" not in plain_args
    assert "--skip-default-registry-fallback" not in plain_args


# --- M8: the per-engagement in-cluster registry ------------------------------


def test_registry_endpoint_and_image_ref():
    assert m.registry_endpoint(ID) == f"registry.engagement-{ID}.svc:5000"
    assert m.target_image_ref(ID) == f"registry.engagement-{ID}.svc:5000/target:latest"


def test_registry_pod_runs_under_gvisor_with_role_registry():
    pod = m.registry_pod_manifest(ID)
    assert pod["kind"] == "Pod"
    assert pod["metadata"]["namespace"] == f"engagement-{ID}"
    assert pod["metadata"]["labels"]["role"] == "registry"
    assert pod["spec"]["runtimeClassName"] == "gvisor"
    assert pod["spec"]["restartPolicy"] == "Never"
    c = pod["spec"]["containers"][0]
    assert c["image"] == m.REGISTRY_IMAGE
    assert c["ports"][0]["containerPort"] == 5000


def test_registry_service_selects_registry_pod_on_5000():
    svc = m.registry_service_manifest(ID)
    assert svc["kind"] == "Service"
    assert svc["spec"]["selector"] == {"engagement": ID, "role": "registry"}
    p = svc["spec"]["ports"][0]
    assert p["port"] == 5000
    assert p["targetPort"] == 5000


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
    assert model["toFQDNs"] == [{"matchName": "openrouter.ai"}]
    port = model["toPorts"][0]["ports"][0]
    assert port == {"port": "443", "protocol": "TCP"}


def test_network_policy_allows_control_plane_ingest_on_backend_port_only():
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
    assert port == {"port": "3000", "protocol": "TCP"}


def test_network_policy_allows_build_to_registry_on_5000_only():
    # M8: the Kaniko build Pod pushes to the in-namespace registry. Intra-namespace,
    # role=registry, 5000 only — without this the fail-closed egress denies the push.
    np = m.network_policy_manifest(ID)
    reg = next(
        r
        for r in _egress_rules(np)
        if r.get("toEndpoints")
        and r["toEndpoints"][0]["matchLabels"].get("role") == "registry"
    )
    assert reg["toEndpoints"][0]["matchLabels"] == {"engagement": ID, "role": "registry"}
    port = reg["toPorts"][0]["ports"][0]
    assert port == {"port": "5000", "protocol": "TCP"}


def test_network_policy_denies_everything_else_by_construction():
    # The security property: exactly the allowed edges, nothing more. Cilium makes
    # an endpoint with any egress rule default-deny, so "only these" IS the deny of
    # Postgres/Redis/Redpanda and arbitrary internet. Five edges: DNS, target,
    # registry (M8), model API, control-plane.
    np = m.network_policy_manifest(ID)
    assert len(_egress_rules(np)) == 5


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
