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

from collections.abc import Mapping, Sequence
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
# Kaniko executor, pinned by digest (M5). The `--registry-mirror` behaviour the
# mirror path relies on (Phase 5) is version-sensitive, so the executor must be an
# exact image, never a floating `:latest`. The `:latest` tag is kept alongside the
# digest for human provenance only — the pull resolves by digest. Re-pin
# deliberately (resolve the new index digest) when bumping Kaniko.
KANIKO_IMAGE = (
    "gcr.io/kaniko-project/executor:latest"
    "@sha256:4e7a52dd1f14872430652bb3b027405b8dfd17c4538751c620ac005741ef9698"
)
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

# --- M5: the in-cluster repo/base mirror (roadmap M8 "Open (→ M5)") -----------
#
# Under the live M7 default-deny egress the Kaniko build Pod can reach no external
# git host or base-image registry, so external `git clone` and `FROM <external>`
# base pulls are denied. M5 closes this WITHOUT widening the egress matrix: the
# conductor (which has egress) clones the repo and preloads each base image into
# the per-engagement registry, then Kaniko builds from an in-cluster `dir://`
# ConfigMap context and resolves bases via `--registry-mirror` pointed at that same
# registry. Everything the build touches now lives inside the namespace.
#
# The ConfigMap name the packed repo workdir is mounted from (paired with a
# `dir://` context, see `kaniko_build_pod_manifest`).
BUILD_CONTEXT_CONFIGMAP = "build-context"

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

# --- build egress (scoped to the Kaniko build Pod only) ----------------------
#
# A target Dockerfile's `RUN` steps (`pip install`, `apt-get install`, …) need the
# public package mirrors, which the namespace-wide default-deny egress (the M7
# `attacker-egress` policy above) blocks — so Kaniko exits 100 (owner sign-off,
# 2026-10-09). We grant that egress via a SEPARATE CiliumNetworkPolicy whose
# `endpointSelector` matches `role=build` ONLY. Cilium egress is additive across
# policies, so this widens the build Pod's allow-set WITHOUT touching the
# attacker/target: they stay on the namespace-wide allow-set, and SEAM-1 (attacker
# reaches only DNS + model API + control-plane + target) is unchanged. The build
# Pod is short-lived, runs under gVisor, pushes only to the in-namespace registry,
# and dies with the namespace at teardown.
#
# DNS gating: the namespace-wide policy's L7 `dns` rule (empty endpointSelector)
# already governs the build Pod, so Cilium's DNS proxy observes the build's lookups
# and learns the answered IPs — this policy only needs the `toFQDNs` egress edges,
# not its own DNS rule, and the egress stays DNS-gated (an IP literal the build never
# resolved is still denied).
BUILD_EGRESS_POLICY_NAME = "build-egress"
# `toFQDNs` match patterns the build Pod may reach on `BUILD_EGRESS_PORTS`. Default
# `*` = any DNS-resolvable host on http/https (owner sign-off, 2026-10-09): a curated
# named-mirror list proved too fragile under Cilium `toFQDNs` because the public
# package mirrors are CDN-backed and rotate IPs faster than enforcement learns them,
# so apt/pip fetches raced and dropped. `*` is robust and still meaningfully scoped —
# it applies to `role=build` ONLY (not the attacker/target), is DNS-proxy-gated, and
# is limited to ports 80/443; the build Pod holds no model key or DB access and those
# services are not on 80/443, so the marginal exposure is low. A deploy can tighten
# this to an explicit pattern list via the builder's `fqdns` (each entry is a Cilium
# `matchPattern`, where `*` is the only wildcard and `.` is literal).
BUILD_EGRESS_FQDNS = ("*",)
# apt defaults to http (80); pip/npm/apk use https (443). Allow both.
BUILD_EGRESS_PORTS = (80, 443)

# The model API allowed by FQDN. A tuple so a mirror/proxy host can be added
# without widening to a CIDR.
MODEL_API_FQDNS = ("openrouter.ai",)
MODEL_API_PORT = 443

# kube-dns: DNS must be explicitly allowed or a default-deny egress blocks name
# resolution and every other allow (which resolve names) fails. The L7 `dns`
# rule is also what lets Cilium learn the `toFQDNs` IPs.
DNS_NAMESPACE = "kube-system"
DNS_SELECTOR = {"k8s-app": "kube-dns"}
DNS_PORT = 53

# The control-plane ingest endpoint (SEAM-1's third allowed edge). Defaults match
# the deploy: the control-plane in the control-plane namespace. The port is the
# pod's CONTAINER port (3000), not the Service port (80): this is a `toEndpoints`
# rule, and Cilium enforces egress against the backend endpoint after socket-LB
# translates the Service VIP, so allowing 80 here never matches the :3000 backend.
CONTROL_PLANE_NAMESPACE = "autosploit-system"
CONTROL_PLANE_SELECTOR = {"app": "control-plane"}
CONTROL_PLANE_PORT = 3000


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


def registry_mirror_endpoint(engagement_id: str) -> str:
    """`host:port` Kaniko's `--registry-mirror` pulls base images from (M5).

    Same per-engagement registry as the push target (`registry_endpoint`): the
    conductor preloads each external base into it, so a `FROM <external>` resolves
    against the mirror without any egress. Kept as its own name so the mirror role
    reads distinctly from the push role at the call sites, even though the host is
    the same in-cluster registry."""
    return registry_endpoint(engagement_id)


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


def build_context_configmap_manifest(
    engagement_id: str,
    files: Mapping[str, str],
    name: str = BUILD_CONTEXT_CONFIGMAP,
) -> dict[str, Any]:
    """The build-context ConfigMap: the packed repo workdir, served in-cluster (M5).

    `files` maps a relative path (`Dockerfile`, `app/main.py`, …) to its text
    content; the conductor packs the cloned repo into this and the Kaniko Pod mounts
    it read-only at `BUILD_CONTEXT_MOUNT`, paired with a `dir://<mount>` context, so
    the build fetches its context from inside the cluster and needs no external
    egress under the M7 default-deny matrix. Namespaced + engagement-labelled like
    every other object, so the namespace delete wipes it at teardown.

    A ConfigMap has a hard 1 MiB ceiling; the caller (provision) enforces that and
    fails closed on oversize — this pure builder only shapes the object.
    """
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": name,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id),
        },
        "data": dict(files),
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
    context_files: Sequence[str] | None = None,
    context_mount: str = BUILD_CONTEXT_MOUNT,
    registry_mirror: str | None = None,
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
    external git host.

    `registry_mirror`, when given, appends `--registry-mirror=<host:port>` plus
    `--insecure-pull` and `--skip-default-registry-fallback` (M5): base-image pulls
    (`FROM <external>`) resolve against that in-cluster mirror — the per-engagement
    registry the conductor preloaded — over plain HTTP, and Kaniko never falls back
    to the external registry (which the M7 egress denies anyway). This is what
    closes the external-`FROM` gap without widening the egress matrix. `--insecure`
    (push-side) still applies independently; the mirror flags govern pulls.

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
            # CPU-cut flags (handoff B1): the build is the one CPU-heavy stretch of
            # an engagement on the single 4-vCPU box, and layer snapshotting +
            # push-side gzip are the hot paths. These shave that CPU without
            # changing what gets built or pushed:
            #  - --use-new-run + --snapshot-mode=redo: drop the full-filesystem-walk
            #    snapshot in favour of the lighter redo snapshotter;
            #  - --single-snapshot: one layer, less diffing (fine for the
            #    single-stage Dockerfile targets this MVP builds);
            #  - --compression-level=1: layer gzip on push is the push-side CPU hog;
            #    level 1 is a large cut vs the default with negligible size change
            #    for an image pushed to a same-node in-cluster registry;
            #  - --compressed-caching=false: skip compressing cached layers in
            #    memory — less CPU and RAM.
            "--use-new-run",
            "--snapshot-mode=redo",
            "--single-snapshot",
            "--compression-level=1",
            "--compressed-caching=false",
        ],
    }
    if registry_mirror is not None:
        container["args"] += [
            # Resolve `FROM <external>` bases against the in-cluster mirror the
            # conductor preloaded, over plain HTTP, and never fall back to the
            # external registry (denied by the M7 egress anyway). This is the pull
            # half of the M5 mirror path; `--insecure` above is the push half.
            f"--registry-mirror={registry_mirror}",
            "--insecure-pull",
            "--skip-default-registry-fallback",
        ]
    spec: dict[str, Any] = {
        "runtimeClassName": RUNTIME_CLASS,
        "restartPolicy": "Never",
        "containers": [container],
    }
    if context_configmap is not None:
        # Mount each context file by `subPath`, NOT the whole ConfigMap as one
        # volume. A whole-volume ConfigMap mount uses Kubernetes' atomic-writer
        # `..data` symlink indirection (every key is a symlink into a hidden
        # timestamped dir); Kaniko then copies those symlinks verbatim on `COPY`,
        # so a `COPY requirements.txt .` lands a symlink whose target does not
        # exist in the built image and a later `RUN` reading the file fails with
        # "No such file or directory". A `subPath` mount projects the real file
        # content with no symlink, so `COPY`/`RUN` see the actual bytes. Keys are
        # flat (a ConfigMap key cannot contain `/`), so one mount per key covers
        # the context. Falls back to the whole-volume mount only when the file
        # list is unknown (no production caller hits that path).
        files = list(context_files) if context_files is not None else []
        if files:
            container["volumeMounts"] = [
                {
                    "name": "build-context",
                    "mountPath": f"{context_mount}/{key}",
                    "subPath": key,
                    "readOnly": True,
                }
                for key in files
            ]
        else:
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


def build_egress_policy_manifest(
    engagement_id: str,
    *,
    fqdns: tuple[str, ...] = BUILD_EGRESS_FQDNS,
    ports: tuple[int, ...] = BUILD_EGRESS_PORTS,
) -> dict[str, Any]:
    """The build-scoped egress CiliumNetworkPolicy — http/https out for Kaniko RUN.

    Selects `role=build` ONLY (not the whole namespace), so it is additive on top of
    the namespace-wide `attacker-egress` policy for the build Pod alone: the attacker
    and target keep their unchanged allow-set (SEAM-1 intact). The single egress edge
    allows `toFQDNs` matching `fqdns` (default `*` = any resolvable host) over `ports`
    (80 for apt, 443 for pip/npm/apk). `toFQDNs` is DNS-proxy-gated by the namespace
    policy's L7 DNS rule, so an unresolved IP literal is still denied.

    Applied just before the build Pod starts (provision), so there is no window where
    the build runs with egress it should not have; if it can't be applied the build
    simply fails under default-deny, a recorded provision failure (fail-closed).
    """
    return {
        "apiVersion": CILIUM_API_VERSION,
        "kind": CILIUM_NETWORK_POLICY_KIND,
        "metadata": {
            "name": BUILD_EGRESS_POLICY_NAME,
            "namespace": namespace_name(engagement_id),
            "labels": engagement_labels(engagement_id, role="build"),
        },
        "spec": {
            "endpointSelector": {
                "matchLabels": engagement_labels(engagement_id, role="build")
            },
            "egress": [
                {
                    "toFQDNs": [{"matchPattern": fqdn} for fqdn in fqdns],
                    "toPorts": [
                        {
                            "ports": [
                                {"port": str(port), "protocol": "TCP"} for port in ports
                            ]
                        }
                    ],
                }
            ],
        },
    }
