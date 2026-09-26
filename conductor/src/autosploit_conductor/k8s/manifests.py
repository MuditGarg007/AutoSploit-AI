"""Pure k8s object builders — the Phase B manifests (docs/orchestration.md §4, §6).

M6 step 1. No API, no `kubernetes` import: every function returns one plain dict
that is a valid Kubernetes object, so the whole layer is unit-testable with no
cluster (the same reason `context.py`/`config_gen.py` are pure). The API-driving
layers (client, watcher, teardown) build these dicts and hand them to the real
`CoreV1Api`.

Three security-load-bearing choices live here and are asserted by the tests, so
review can trust them without re-reading the cluster:

- **`runtimeClassName: gvisor` on every Pod** — real isolation for untrusted code
  (`orchestration.md §4`; the RuntimeClass is installed by M4).
- **`restartPolicy: Never`** — an engagement runs exactly once; a crashed attacker
  or target is a terminal outcome to record, not a thing to restart into a loop.
- **the model key travels as a `secretKeyRef`, never as a plaintext env value** in
  the Pod spec — the key lands in a Secret object (`secret_manifest`) and the Pod
  only names it (`orchestration.md §6` [3], the §2 trust boundary). A plaintext
  `env.value` would print the key in `kubectl get pod -o yaml`; the ref does not.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# The gVisor RuntimeClass name installed by M4 (`scripts/m4-bootstrap.sh`:
# `kind: RuntimeClass / name: gvisor / handler: runsc`). Every engagement Pod
# runs under it.
RUNTIME_CLASS = "gvisor"

# Label key carried by every object in an engagement, mirroring the Phase-A
# Docker label `engagement=<id>` (provisioner teardown). A label selector on it
# is how the Service finds the target Pod and how humans find an engagement's
# objects.
ENGAGEMENT_LABEL = "engagement"

# Role label so attacker and target are distinguishable within one namespace
# (the Service selects on `role=target`).
ROLE_LABEL = "role"

# The env var name the harness reads the model key from (Seam B / launch.py).
API_KEY_ENV = "OPENROUTER_API_KEY"

# Secret + key names. The Secret is named per engagement; the harness's env var
# is populated from this key inside it.
SECRET_NAME = "model-key"

# ConfigMap holding scope.yaml + run.toml, mounted read-only into the attacker.
CONFIG_MAP_NAME = "run-config"
CONFIG_MOUNT_PATH = "/etc/autosploit"

# The target Service name. Its cluster DNS is what the scope `host` becomes under
# k8s (M6a / contract 1.1.0): `target.engagement-<id>.svc.cluster.local`.
TARGET_SERVICE_NAME = "target"

# --- M8: the in-cluster target build (orchestration.md; roadmap M8) -----------
#
# The user repo is built into the target image INSIDE the cluster with Kaniko, so
# there is no Docker daemon and no docker socket anywhere in the path — mounting a
# host docker.sock into a build that runs untrusted repo content would hand root on
# the node to that content, the exact thing this step forbids. Kaniko builds each
# Dockerfile layer in userspace and pushes the result to the registry.
#
# The build runs as a Pod (not a Job) so it reuses the same watcher/`pod_phase`
# path as the attacker and target: restartPolicy Never + gVisor, watched to a
# terminal phase, then the target Pod is deployed from the pushed image.
#
# Kaniko's executor runs as uid 0 *inside its own container* by design (it rewrites
# the image root filesystem), so this Pod is deliberately NOT `runAsNonRoot`. Its
# isolation is the gVisor jail, the absence of any docker socket / hostPath, and no
# privilege — never in-container non-root. The tests assert that shape.
BUILD_POD_NAME = "build"
# Placeholder Kaniko executor ref, kept obvious like `_DEFAULT_ATTACKER_IMAGE` so an
# unpinned build image can't masquerade as vetted. Digest-pin lands with M9.
KANIKO_IMAGE = "gcr.io/kaniko-project/executor:latest"
# Default Dockerfile path within the build context (Dockerfile repos only for MVP;
# compose is deferred, roadmap §5).
DEFAULT_DOCKERFILE = "Dockerfile"

# Per-engagement in-cluster registry (M8 registry decision, 2026-09-26): Kaniko
# pushes the built target image here, and the target Pod is deployed from it. Kept
# in-namespace so no external push credential ever sits next to untrusted repo
# content and the whole build path works air-gapped (the env M6/M7 proved on). The
# push is plain HTTP inside the cluster (`--insecure`); nothing here is exposed off
# the node. Registry ↔ node-DNS image-pull is a live-proof concern, not a manifest one.
REGISTRY_POD_NAME = "registry"
REGISTRY_SERVICE_NAME = "registry"
REGISTRY_IMAGE = "registry:2"
REGISTRY_PORT = 5000

# --- M7: the egress matrix (orchestration.md §4.1, §6 [1]) -------------------
#
# The engagement namespace holds untrusted code (the agent loop and the target
# built from the user repo). Left open it could exfiltrate to anywhere on the
# network. M7 pins the namespace's egress to exactly the §4.1 matrix edges and
# denies the rest, enforced by Cilium.
#
# The policy selects the WHOLE namespace (empty `endpointSelector`), not just the
# attacker: it is the namespace's default-deny-egress baseline plus the allow-set,
# so every Pod here — attacker, target, and any probe — is governed, and a Pod
# that matched no policy (Cilium default-allow) can't slip egress. This mirrors
# the M4 smoke's namespace-wide `podSelector: {}` and is what redteam.sh SEAM-1
# probes. (Splitting the target down to DNS-only least-privilege is a deferred
# hardening, see docs/deferred-open-items.md; the target sharing the allow-set
# still can't reach arbitrary internet or the DB plane ports.)
#
# We use a **CiliumNetworkPolicy** (not a plain k8s NetworkPolicy) because the
# model-API allow is by hostname (`toFQDNs`): a plain NetworkPolicy can only match
# IP CIDRs, so it cannot distinguish the model API from arbitrary internet — the
# exact discrimination redteam.sh SEAM-1 tests.
#
# Cilium's own selectors use a `k8s:`-prefixed namespace label to cross namespaces.
CILIUM_API_VERSION = "cilium.io/v2"
CILIUM_NETWORK_POLICY_KIND = "CiliumNetworkPolicy"
NETWORK_POLICY_NAME = "attacker-egress"
NAMESPACE_LABEL = "k8s:io.kubernetes.pod.namespace"

# The model API allowed by FQDN. A tuple so a mirror/proxy host can be added
# without widening to a CIDR.
MODEL_API_FQDNS = ("api.openrouter.ai",)
MODEL_API_PORT = 443

# kube-dns: DNS must be explicitly allowed or a default-deny egress blocks name
# resolution and every other allow (which resolve names) fails. The L7 `dns`
# rule is also what lets Cilium learn the `toFQDNs` IPs.
DNS_NAMESPACE = "kube-system"
DNS_SELECTOR = {"k8s-app": "kube-dns"}
DNS_PORT = 53

# The control-plane ingest endpoint (SEAM-1's third allowed edge). Defaults match
# the deploy: the control-plane Service in the control-plane namespace, on 80.
CONTROL_PLANE_NAMESPACE = "autosploit-system"
CONTROL_PLANE_SELECTOR = {"app": "control-plane"}
CONTROL_PLANE_PORT = 80


def namespace_name(engagement_id: str) -> str:
    """`engagement-<id>` — the per-run namespace; deleting it is full teardown."""
    return f"engagement-{engagement_id}"


def engagement_labels(engagement_id: str, role: str | None = None) -> dict[str, str]:
    """Common labels for every object in the engagement, plus an optional role."""
    labels = {ENGAGEMENT_LABEL: engagement_id}
    if role is not None:
        labels[ROLE_LABEL] = role
    return labels


def target_service_dns(engagement_id: str) -> str:
    """Cluster DNS the attacker reaches the target on (scope `host`, M6a)."""
    return f"{TARGET_SERVICE_NAME}.{namespace_name(engagement_id)}.svc.cluster.local"


def registry_endpoint(engagement_id: str) -> str:
    """`host:port` of the per-engagement registry (Kaniko push + target pull, M8).

    The short Service form (`registry.engagement-<id>.svc:5000`) — in-cluster DNS
    resolves it for the build Pod's push. The image ref appends a repo/tag."""
    return f"{REGISTRY_SERVICE_NAME}.{namespace_name(engagement_id)}.svc:{REGISTRY_PORT}"


def target_image_ref(engagement_id: str) -> str:
    """The built target image ref: `<registry endpoint>/target:latest` (M8).

    Kaniko's `--destination` and the target Pod's `image` are the same ref — build
    pushes it, the target runs it."""
    return f"{registry_endpoint(engagement_id)}/target:latest"


def namespace_manifest(engagement_id: str) -> dict[str, Any]:
    """The `engagement-<id>` Namespace (orchestration.md §6 [1])."""
    return {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
    }


def secret_manifest(engagement_id: str, api_key: str) -> dict[str, Any]:
    """The model-key Secret the attacker Pod references (never inlines).

    `stringData` lets the API server take the raw value and base64-encode it; the
    key exists only inside this object and the attacker Pod's env at runtime —
    never in the Pod spec, never in the provisioner (§2 trust boundary).
    """
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {
            "name": SECRET_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
        "stringData": {API_KEY_ENV: api_key},
    }


def configmap_manifest(
    engagement_id: str, files: Mapping[str, str]
) -> dict[str, Any]:
    """A ConfigMap holding the run files (scope.yaml, run.toml) for the attacker.

    `files` maps a basename to its text; the attacker mounts the whole map at
    `CONFIG_MOUNT_PATH`, so `run.toml`'s relative `scope_file` resolves next to it
    exactly as it does on disk in Phase A (config_gen.py §3.2).
    """
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": CONFIG_MAP_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
        "data": dict(files),
    }


def attacker_pod_manifest(
    engagement_id: str,
    image: str,
    *,
    run_config_basename: str = "run.toml",
    command: list[str] | None = None,
    args: list[str] | None = None,
) -> dict[str, Any]:
    """The attacker Pod: harness image, key from the Secret, run files mounted.

    Security-load-bearing (see module docstring): `runtimeClassName: gvisor`,
    `restartPolicy: Never`, and the key delivered via `secretKeyRef` — the Pod
    spec names the Secret, it never carries the key value.

    `command`/`args` override the default entrypoint. They default to the harness
    CLI (`run --config <mounted run.toml>`); the override exists so a stand-in
    attacker image (e.g. the live M6 exit-gate test's curl probe) can run through
    this same builder and the same `create_attacker_pod` path.
    """
    container: dict[str, Any] = {
        "name": "attacker",
        "image": image,
    }
    if command is not None:
        container["command"] = command
    container["args"] = (
        args
        if args is not None
        else ["run", "--config", f"{CONFIG_MOUNT_PATH}/{run_config_basename}"]
    )
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": "attacker",
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id, role="attacker"),
        },
        "spec": {
            "runtimeClassName": RUNTIME_CLASS,
            "restartPolicy": "Never",
            "containers": [
                {
                    **container,
                    "env": [
                        {
                            "name": API_KEY_ENV,
                            "valueFrom": {
                                "secretKeyRef": {
                                    "name": SECRET_NAME,
                                    "key": API_KEY_ENV,
                                }
                            },
                        }
                    ],
                    "volumeMounts": [
                        {
                            "name": "run-config",
                            "mountPath": CONFIG_MOUNT_PATH,
                            "readOnly": True,
                        }
                    ],
                }
            ],
            "volumes": [
                {
                    "name": "run-config",
                    "configMap": {"name": CONFIG_MAP_NAME},
                }
            ],
        },
    }


def target_pod_manifest(
    engagement_id: str, image: str, *, container_port: int
) -> dict[str, Any]:
    """The target Pod built from the user repo. Untrusted code — same gVisor jail.

    No Secret, no config mount: the target is the user's app under test, and it
    must never see the model key (§2). `role=target` so the Service selects it.
    """
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": "target",
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id, role="target"),
        },
        "spec": {
            "runtimeClassName": RUNTIME_CLASS,
            "restartPolicy": "Never",
            "containers": [
                {
                    "name": "target",
                    "image": image,
                    "ports": [{"containerPort": container_port}],
                }
            ],
        },
    }


def target_service_manifest(
    engagement_id: str, *, port: int, target_port: int | None = None
) -> dict[str, Any]:
    """The Service giving the target stable DNS the attacker connects to (§4).

    Selects the target Pod by `role=target`. `port` is the port the attacker
    dials; `target_port` (defaults to `port`) is the container port behind it.
    """
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": TARGET_SERVICE_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
        "spec": {
            "selector": engagement_labels(engagement_id, role="target"),
            "ports": [
                {
                    "port": port,
                    "targetPort": target_port if target_port is not None else port,
                }
            ],
        },
    }


def registry_pod_manifest(engagement_id: str) -> dict[str, Any]:
    """The per-engagement image registry Pod (M8): Kaniko pushes here, target pulls.

    Same engagement invariants as every Pod (gVisor, restartPolicy Never) and
    role=registry so its Service selects it. Holds only images built this run; the
    namespace delete wipes it at teardown."""
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": REGISTRY_POD_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id, role="registry"),
        },
        "spec": {
            "runtimeClassName": RUNTIME_CLASS,
            "restartPolicy": "Never",
            "containers": [
                {
                    "name": REGISTRY_POD_NAME,
                    "image": REGISTRY_IMAGE,
                    "ports": [{"containerPort": REGISTRY_PORT}],
                }
            ],
        },
    }


def registry_service_manifest(engagement_id: str) -> dict[str, Any]:
    """The Service giving the registry stable DNS (`registry.<ns>.svc:5000`, M8)."""
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": REGISTRY_SERVICE_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
        "spec": {
            "selector": engagement_labels(engagement_id, role="registry"),
            "ports": [{"port": REGISTRY_PORT, "targetPort": REGISTRY_PORT}],
        },
    }


BUILD_CONTEXT_MOUNT = "/workspace"


def kaniko_build_pod_manifest(
    engagement_id: str,
    *,
    context: str,
    destination: str,
    dockerfile: str = DEFAULT_DOCKERFILE,
    image: str = KANIKO_IMAGE,
    context_configmap: str | None = None,
    context_mount: str = BUILD_CONTEXT_MOUNT,
) -> dict[str, Any]:
    """The Kaniko build Pod: clone `context`, build `dockerfile`, push `destination`.

    `context` is a Kaniko context URI (e.g. `git://host/org/repo#ref`); `destination`
    is the registry ref the built image is pushed to and the target Pod later runs
    from. Dockerfile repos only for MVP (compose deferred, roadmap §5).

    `context_configmap`, when given, mounts that ConfigMap read-only at
    `context_mount` and is meant to pair with a `dir://<context_mount>` `context`:
    it supplies the build context **from inside the cluster**, so Kaniko needs no
    external egress to fetch it. This is the in-cluster-context path the M8 live
    proof uses under the M7 default-deny egress, which denies the build Pod any
    external git host (external clone is a tracked open item; see roadmap §5 / M5).

    Security-load-bearing (module docstring, roadmap M8 exit): `runtimeClassName:
    gvisor` and `restartPolicy: Never` like every engagement Pod, and — the whole
    point of building with Kaniko — **no docker socket, no hostPath, not
    privileged**. A ConfigMap context volume is none of those: it is in-cluster
    API data, not a host mount. Kaniko runs as root inside its own container by
    design, so this is intentionally not `runAsNonRoot`; the isolation is the
    gVisor jail and the absence of any host mount or privilege. The tests assert
    each of these.
    """
    container: dict[str, Any] = {
        "name": BUILD_POD_NAME,
        "image": image,
        "args": [
            f"--context={context}",
            f"--dockerfile={dockerfile}",
            f"--destination={destination}",
            # The per-engagement registry is plain HTTP inside the cluster (no TLS,
            # nothing exposed off the node). Without this Kaniko attempts HTTPS to
            # the registry Service and the push fails. Push-side only; base-image
            # pulls from a real registry still use TLS.
            "--insecure",
        ],
    }
    spec: dict[str, Any] = {
        "runtimeClassName": RUNTIME_CLASS,
        "restartPolicy": "Never",
        "containers": [container],
    }
    if context_configmap is not None:
        container["volumeMounts"] = [
            {"name": "build-context", "mountPath": context_mount, "readOnly": True}
        ]
        spec["volumes"] = [
            {"name": "build-context", "configMap": {"name": context_configmap}}
        ]
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": BUILD_POD_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id, role="build"),
        },
        "spec": spec,
    }


def network_policy_manifest(
    engagement_id: str,
    *,
    model_fqdns: tuple[str, ...] = MODEL_API_FQDNS,
    model_port: int = MODEL_API_PORT,
    control_plane_namespace: str = CONTROL_PLANE_NAMESPACE,
    control_plane_selector: Mapping[str, str] = CONTROL_PLANE_SELECTOR,
    control_plane_port: int = CONTROL_PLANE_PORT,
) -> dict[str, Any]:
    """The engagement-egress CiliumNetworkPolicy — SEAM-1 made literal (§4.1).

    Governs every Pod in the engagement namespace (empty `endpointSelector`).
    Cilium treats an endpoint with *any* egress rule as default-deny egress, so
    listing the four allowed edges below denies every other destination by
    construction:

    1. **DNS** to kube-dns (53 UDP+TCP) with an L7 `dns` visibility rule — both a
       hard requirement (nothing resolves under default-deny without it) and the
       mechanism Cilium uses to learn the `toFQDNs` IPs.
    2. **target** — any port on the same-engagement `role=target` endpoint.
    2b. **registry** (M8) — the same-engagement `role=registry` endpoint on 5000, so
       the Kaniko build Pod can push the built image; intra-namespace only.
    3. **model API** — `toFQDNs` on `model_fqdns`, port `model_port` (443). Allowing
       by name, not CIDR, is why this is a CiliumNetworkPolicy (see module notes).
    4. **control plane** — the ingest endpoint, `control_plane_port` (80).

    All parameters carry deploy-matching defaults so `run.py`/`factory` can call
    this with the engagement id alone, and a test or a different deploy can override
    the control-plane location or the model host without touching the builder.
    """
    dns_ports = [
        {"port": str(DNS_PORT), "protocol": proto} for proto in ("UDP", "TCP")
    ]
    egress: list[dict[str, Any]] = [
        # 1. DNS — must come first conceptually: everything else resolves names.
        {
            "toEndpoints": [
                {"matchLabels": {NAMESPACE_LABEL: DNS_NAMESPACE, **DNS_SELECTOR}}
            ],
            "toPorts": [
                {"ports": dns_ports, "rules": {"dns": [{"matchPattern": "*"}]}}
            ],
        },
        # 2. attacker -> target (same engagement, same namespace), any port.
        {
            "toEndpoints": [
                {"matchLabels": engagement_labels(engagement_id, role="target")}
            ]
        },
        # 2b. build -> registry (M8): the Kaniko Pod pushes the built image to the
        # in-namespace registry on 5000. Intra-namespace, same engagement; the empty
        # endpointSelector means this rule is what lets that push through the
        # otherwise default-deny egress. Registry holds only this run's images and
        # dies with the namespace.
        {
            "toEndpoints": [
                {"matchLabels": engagement_labels(engagement_id, role="registry")}
            ],
            "toPorts": [
                {"ports": [{"port": str(REGISTRY_PORT), "protocol": "TCP"}]}
            ],
        },
        # 3. attacker -> model API, by hostname, on 443 only.
        {
            "toFQDNs": [{"matchName": fqdn} for fqdn in model_fqdns],
            "toPorts": [
                {"ports": [{"port": str(model_port), "protocol": "TCP"}]}
            ],
        },
        # 4. attacker -> control-plane ingest, on 80 only.
        {
            "toEndpoints": [
                {
                    "matchLabels": {
                        NAMESPACE_LABEL: control_plane_namespace,
                        **control_plane_selector,
                    }
                }
            ],
            "toPorts": [
                {"ports": [{"port": str(control_plane_port), "protocol": "TCP"}]}
            ],
        },
    ]
    return {
        "apiVersion": CILIUM_API_VERSION,
        "kind": CILIUM_NETWORK_POLICY_KIND,
        "metadata": {
            "name": NETWORK_POLICY_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
        "spec": {
            # Empty selector = every Pod in this namespace (default-deny baseline
            # + the allow-set above). Namespace isolation is by the object living
            # in `engagement-<id>`, so it needs no engagement label to scope it.
            "endpointSelector": {},
            "egress": egress,
        },
    }
