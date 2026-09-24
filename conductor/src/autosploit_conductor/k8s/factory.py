"""Real CoreV1Api factory — the ONE place `kubernetes` is imported (M6 step 5).

Every other Phase B module (`manifests`, `client`, `watch`, `run`) is free of any
`kubernetes` import, which is why they unit-test with nothing installed. This
factory is the single seam where the real SDK is constructed; the CLI calls it,
tests never do.

Config resolution mirrors how the conductor is deployed:
- **in-cluster** — when the conductor runs as a Pod it reads its ServiceAccount
  token (`load_incluster_config`); this is the production path (M9 Helm chart).
- **kubeconfig** — a developer running the CLI against a kind/GKE context falls
  back to `~/.kube/config`.

Any failure (SDK missing, or neither config source available) is surfaced as a
`ConductorError` so the CLI reports it cleanly and exits non-zero, never a raw
traceback.
"""

from __future__ import annotations

from typing import Any

from autosploit_conductor.context import ConductorError


def build_core_v1() -> Any:
    """Construct a real `kubernetes.client.CoreV1Api`, or raise `ConductorError`.

    Returns `Any` so importing this module needs no `kubernetes` types; the object
    it returns satisfies the `client.CoreV1` Protocol the rest of Phase B depends
    on.
    """
    try:
        from kubernetes import client, config
        from kubernetes.config.config_exception import ConfigException
    except ImportError as exc:  # pragma: no cover - exercised only without the SDK
        raise ConductorError(
            "the kubernetes client is required for the --k8s path; "
            "install it (e.g. `pip install kubernetes`)"
        ) from exc

    try:
        config.load_incluster_config()
    except ConfigException:
        try:
            config.load_kube_config()
        except Exception as exc:
            raise ConductorError(
                "no Kubernetes config found: not running in-cluster and no usable "
                "kubeconfig (set KUBECONFIG or run inside the cluster)"
            ) from exc

    return client.CoreV1Api()


def build_custom_objects() -> Any:
    """Construct a real `kubernetes.client.CustomObjectsApi`, or raise `ConductorError`.

    Used for the CiliumNetworkPolicy CRD (M7). Config is already resolved by the
    time this is called alongside `build_core_v1`; kept a separate function so the
    single `kubernetes` import stays confined to this factory module.
    """
    try:
        from kubernetes import client
    except ImportError as exc:  # pragma: no cover - exercised only without the SDK
        raise ConductorError(
            "the kubernetes client is required for the --k8s path; "
            "install it (e.g. `pip install kubernetes`)"
        ) from exc

    return client.CustomObjectsApi()
