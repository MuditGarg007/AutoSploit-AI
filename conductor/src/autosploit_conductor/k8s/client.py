"""Engagement cluster client — thin wrapper over CoreV1Api (docs/orchestration.md §6).

M6 step 2. The first layer that drives the Kubernetes API, but the API object is
*injected*: `EngagementCluster(api, engagement_id=...)` takes anything shaped like
`kubernetes.client.CoreV1Api`, so the whole controller is unit-tested against a
fake API with no live cluster — the same seam Phase A uses to inject a fake
provisioner/harness (`run.py` `provision_cmd`/`harness_cmd`).

Each method is deliberately thin: build a manifest (`manifests.py`, the pure
layer) and hand it to the matching API call. The only real logic here is the two
idempotency rules that teardown safety depends on:

- **create namespace** — a namespace that already exists (`409 Conflict`) is not
  an error; a retried run reuses it.
- **delete namespace** — a namespace already gone (`404 Not Found`) is not an
  error; teardown must be idempotent (runs on success, failure, interruption —
  `orchestration.md §6` [5]).

Both are matched on the exception's `.status` (the real
`kubernetes.client.rest.ApiException` and the test fake both carry an int
`.status`), so this module needs no `kubernetes` import — the real client is
constructed one layer up, isolated in a factory.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from autosploit_conductor.k8s import manifests as m

_HTTP_CONFLICT = 409
_HTTP_NOT_FOUND = 404

# CiliumNetworkPolicy is a custom resource, so it is applied through
# CustomObjectsApi (not CoreV1) addressed by group/version/plural (M7).
_CILIUM_GROUP = "cilium.io"
_CILIUM_VERSION = "v2"
_CILIUM_PLURAL = "ciliumnetworkpolicies"


def _http_status(exc: BaseException) -> int | None:
    """The HTTP status of a k8s API exception, or None if it isn't one.

    Both `kubernetes.client.rest.ApiException` and the test fake expose an int
    `.status`; anything without one is a genuine error and is re-raised by the
    callers, never swallowed.
    """
    status = getattr(exc, "status", None)
    return status if isinstance(status, int) else None


class CoreV1(Protocol):
    """The slice of `kubernetes.client.CoreV1Api` this wrapper uses.

    A Protocol so both the real client and the fake satisfy it structurally, and
    so a reader sees exactly which API surface Phase B depends on.
    """

    def create_namespace(self, body: Any) -> Any: ...
    def delete_namespace(self, name: str) -> Any: ...
    def create_namespaced_secret(self, namespace: str, body: Any) -> Any: ...
    def create_namespaced_config_map(self, namespace: str, body: Any) -> Any: ...
    def create_namespaced_pod(self, namespace: str, body: Any) -> Any: ...
    def create_namespaced_service(self, namespace: str, body: Any) -> Any: ...
    def read_namespaced_pod(self, name: str, namespace: str) -> Any: ...
    def read_namespaced_pod_log(self, name: str, namespace: str) -> Any: ...


class CustomObjects(Protocol):
    """The slice of `kubernetes.client.CustomObjectsApi` this wrapper uses.

    CiliumNetworkPolicy is a CRD, so it does not go through CoreV1; it is created
    as a namespaced custom object addressed by group/version/plural (M7).
    """

    def create_namespaced_custom_object(
        self, group: str, version: str, namespace: str, plural: str, body: Any
    ) -> Any: ...


class EngagementCluster:
    """All the cluster mutations for one engagement, scoped to its namespace."""

    def __init__(
        self,
        api: CoreV1,
        engagement_id: str,
        *,
        custom: CustomObjects | None = None,
    ) -> None:
        self._api = api
        # The CustomObjectsApi for the CiliumNetworkPolicy CRD. Defaults to `api`
        # so a single combined fake (and every existing CoreV1-only call site)
        # keeps working; production injects a real CustomObjectsApi (factory).
        self._custom: CustomObjects = custom if custom is not None else api  # type: ignore[assignment]
        self.engagement_id = engagement_id
        self.namespace = m.namespace_name(engagement_id)

    # --- lifecycle: namespace ------------------------------------------------

    def create_namespace(self) -> None:
        """Create `engagement-<id>`. A pre-existing namespace (409) is fine."""
        try:
            self._api.create_namespace(body=m.namespace_manifest(self.engagement_id))
        except Exception as exc:
            if _http_status(exc) == _HTTP_CONFLICT:
                return
            raise

    def delete_namespace(self) -> None:
        """Delete the namespace (full teardown). Already-gone (404) is fine.

        Idempotent by contract: a second call, or a call after the namespace was
        never created, is a no-op — so this is safe in a `finally` and on
        SIGINT/SIGTERM (`orchestration.md §6` [5]).
        """
        try:
            self._api.delete_namespace(name=self.namespace)
        except Exception as exc:
            if _http_status(exc) == _HTTP_NOT_FOUND:
                return
            raise

    # --- egress policy (governs the untrusted attacker, M7) ------------------

    def apply_network_policy(self, **overrides: Any) -> None:
        """Apply the attacker-egress CiliumNetworkPolicy (SEAM-1, §4.1).

        Must run after the namespace exists and BEFORE the attacker Pod, so there
        is never a window where the attacker runs unpoliced. `overrides` pass
        through to `network_policy_manifest` (model host / control-plane location).
        """
        self._custom.create_namespaced_custom_object(
            group=_CILIUM_GROUP,
            version=_CILIUM_VERSION,
            namespace=self.namespace,
            plural=_CILIUM_PLURAL,
            body=m.network_policy_manifest(self.engagement_id, **overrides),
        )

    # --- attacker-side objects (trusted: hold/reference the key) -------------

    def apply_secret(self, api_key: str) -> None:
        """Create the model-key Secret in the namespace (the one key, §2)."""
        self._api.create_namespaced_secret(
            namespace=self.namespace,
            body=m.secret_manifest(self.engagement_id, api_key),
        )

    def apply_configmap(self, files: Mapping[str, str]) -> None:
        """Create the run-config ConfigMap (scope.yaml + run.toml) for the attacker."""
        self._api.create_namespaced_config_map(
            namespace=self.namespace,
            body=m.configmap_manifest(self.engagement_id, files),
        )

    def create_attacker_pod(
        self,
        image: str,
        *,
        run_config_basename: str = "run.toml",
        command: list[str] | None = None,
        args: list[str] | None = None,
    ) -> None:
        """Launch the attacker Pod (harness image, key by Secret ref, config mounted).

        `command`/`args` override the entrypoint (default: the harness CLI) — used
        by the live exit-gate test to run a stand-in attacker through this path.
        """
        self._api.create_namespaced_pod(
            namespace=self.namespace,
            body=m.attacker_pod_manifest(
                self.engagement_id,
                image,
                run_config_basename=run_config_basename,
                command=command,
                args=args,
            ),
        )

    # --- target-side objects (untrusted: never see the key) ------------------

    def create_registry_pod(self) -> None:
        """Deploy the per-engagement in-cluster registry Pod (M8 push/pull target)."""
        self._api.create_namespaced_pod(
            namespace=self.namespace,
            body=m.registry_pod_manifest(self.engagement_id),
        )

    def create_registry_service(self) -> str:
        """Expose the registry via a Service; return its `host:port` endpoint (M8)."""
        self._api.create_namespaced_service(
            namespace=self.namespace,
            body=m.registry_service_manifest(self.engagement_id),
        )
        return m.registry_endpoint(self.engagement_id)

    def create_build_pod(
        self,
        *,
        context: str,
        destination: str,
        dockerfile: str = m.DEFAULT_DOCKERFILE,
        image: str = m.KANIKO_IMAGE,
        context_configmap: str | None = None,
    ) -> None:
        """Launch the Kaniko build Pod that builds the target image (M8).

        Create-only, like the other Pod builders: the provision layer watches it to
        a terminal phase and deploys the target from `destination` on success. The
        build runs untrusted repo content, so — same as the target — it never sees
        the key, and (the point of Kaniko) has no docker socket in its spec.

        `context_configmap`, when set, supplies the build context from an in-cluster
        ConfigMap (pair with a `dir://` `context`) so the build needs no external
        egress — the M8 live-proof path under the M7 default-deny matrix.
        """
        self._api.create_namespaced_pod(
            namespace=self.namespace,
            body=m.kaniko_build_pod_manifest(
                self.engagement_id,
                context=context,
                destination=destination,
                dockerfile=dockerfile,
                image=image,
                context_configmap=context_configmap,
            ),
        )

    def create_target_pod(self, image: str, *, container_port: int) -> None:
        """Deploy the target Pod built from the user repo (gVisor, no key)."""
        self._api.create_namespaced_pod(
            namespace=self.namespace,
            body=m.target_pod_manifest(
                self.engagement_id, image, container_port=container_port
            ),
        )

    def create_target_service(self, *, port: int, target_port: int | None = None) -> str:
        """Expose the target via a Service and return its cluster DNS (the scope host)."""
        self._api.create_namespaced_service(
            namespace=self.namespace,
            body=m.target_service_manifest(
                self.engagement_id, port=port, target_port=target_port
            ),
        )
        return m.target_service_dns(self.engagement_id)

    # --- reads (for the watcher, step 3) -------------------------------------

    def pod_phase(self, name: str) -> str | None:
        """The Pod's `status.phase` (Pending/Running/Succeeded/Failed), or None.

        None when the phase can't be read yet (the Pod object exists but has no
        status, or the read shape is unexpected) — the watcher treats that as
        "not terminal yet" and polls again.
        """
        pod = self._api.read_namespaced_pod(name=name, namespace=self.namespace)
        return _phase_of(pod)

    def pod_logs(self, name: str) -> str:
        """The Pod's logs — the harness event stream (Phase A's streamed stdout)."""
        logs = self._api.read_namespaced_pod_log(name=name, namespace=self.namespace)
        return logs if isinstance(logs, str) else str(logs)

    def container_exit_code(self, name: str) -> int | None:
        """The Pod's first container's terminated exit code, or None if not terminated.

        Needed only to tell a clean partial halt (Seam B exit 2) from a genuine
        failure on a `Failed` Pod — a `Succeeded` Pod is always exit 0. Lives at
        `status.containerStatuses[0].state.terminated.exitCode`.
        """
        pod = self._api.read_namespaced_pod(name=name, namespace=self.namespace)
        return _exit_code_of(pod)


def _phase_of(pod: Any) -> str | None:
    """Read `status.phase` off a Pod, tolerating both client objects and dicts.

    The real client returns a `V1Pod` (`pod.status.phase`); a fake may return a
    plain dict (`pod["status"]["phase"]`). Anything else → None.
    """
    status = getattr(pod, "status", None)
    if status is not None:
        phase = getattr(status, "phase", None)
        if isinstance(phase, str):
            return phase
    if isinstance(pod, Mapping):
        status_d = pod.get("status")
        if isinstance(status_d, Mapping):
            phase = status_d.get("phase")
            if isinstance(phase, str):
                return phase
    return None


def _exit_code_of(pod: Any) -> int | None:
    """Read `status.containerStatuses[0].state.terminated.exitCode`, or None.

    Tolerates both a client `V1Pod` (attribute chain) and a plain dict (the test
    fake); anything short of a terminated container → None.
    """
    statuses = _dig(pod, "status", "container_statuses") or _dig(pod, "status", "containerStatuses")
    if not statuses:
        return None
    terminated = _dig(statuses[0], "state", "terminated")
    if terminated is None:
        return None
    code = _dig(terminated, "exit_code")
    if code is None:
        code = _dig(terminated, "exitCode")
    return code if isinstance(code, int) else None


def _dig(obj: Any, *path: str) -> Any:
    """Walk attributes or mapping keys along `path`, returning None on any miss."""
    cur = obj
    for key in path:
        if cur is None:
            return None
        nxt = getattr(cur, key, None)
        if nxt is None and isinstance(cur, Mapping):
            nxt = cur.get(key)
        cur = nxt
    return cur
