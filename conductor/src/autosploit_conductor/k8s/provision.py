"""Phase B provision — the in-cluster target build (roadmap M8).

`run_k8s` hands this seam the `EngagementCluster` and expects a `K8sProvision`
back (or an exception, which it records as a clean `failed(provision)` — the target
never came up — rather than a crash, mirroring Phase A §8).

The real work, all inside the engagement namespace so nothing touches the node and
the whole path works air-gapped (M8 registry decision, 2026-09-26):

1. stand up the per-engagement in-cluster registry (Pod + Service) and wait for it
   to be `Running` — Kaniko pushes to it, the target Pod later pulls from it;
2. run the **Kaniko** build Pod (`git clone` the repo → build the Dockerfile in
   userspace → push to the registry), with **no docker socket anywhere** — the
   point of the milestone — and watch it to `Succeeded`;
3. emit the ConfigMap payload (scope.yaml pointing at the target Service DNS +
   run.toml), which shares the M6a scope contract, and return the built image ref.

The target port is supplied by the operator (`--target-port`), bound in by the CLI
via `functools.partial`, because a Dockerfile repo does not reliably declare it.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping

from autosploit_conductor import config_gen
from autosploit_conductor.context import EngagementContext
from autosploit_conductor.k8s import manifests as m
from autosploit_conductor.k8s.client import EngagementCluster
from autosploit_conductor.k8s.run import K8sProvision
from autosploit_conductor.k8s.watch import wait_pod_running, watch_pod

# Where the harness writes its report inside the attacker Pod. Pod-local: the report
# is collected from the Pod (logs), not a shared disk (run.py `_collect_logs`).
_POD_OUTPUT_DIR = "/tmp/autosploit-out"
_SCOPE_BASENAME = "scope.yaml"


class ProvisionError(RuntimeError):
    """The target never came up — recorded as failed(provision), not a crash."""


def phaseb_provision(
    repo_ref: str,
    ctx: EngagementContext,
    cluster: EngagementCluster,
    *,
    target_port: int,
    service_port: int | None = None,
    dockerfile: str = m.DEFAULT_DOCKERFILE,
    registry_timeout_s: float = 120.0,
    build_timeout_s: float = 900.0,
    poll_interval_s: float = 2.0,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> K8sProvision:
    """Build the target in-cluster with Kaniko and return its deploy handle (M8)."""
    engagement_id = ctx.engagement_id
    destination = m.target_image_ref(engagement_id)

    # 1. Registry up and ready before anything pushes to it.
    cluster.create_registry_pod()
    cluster.create_registry_service()
    if not wait_pod_running(
        cluster,
        m.REGISTRY_POD_NAME,
        timeout_s=registry_timeout_s,
        poll_interval_s=poll_interval_s,
        now=now,
        sleep=sleep,
    ):
        raise ProvisionError("in-cluster registry did not become ready")

    # 2. Kaniko build → push. Watch to a terminal phase; only Succeeded is a build.
    cluster.create_build_pod(
        context=_kaniko_context(repo_ref),
        destination=destination,
        dockerfile=dockerfile,
    )
    outcome = watch_pod(
        cluster,
        m.BUILD_POD_NAME,
        timeout_s=build_timeout_s,
        poll_interval_s=poll_interval_s,
        now=now,
        sleep=sleep,
    )
    if outcome.timed_out:
        raise ProvisionError("kaniko build timed out")
    if outcome.phase != "Succeeded":
        raise ProvisionError(
            f"kaniko build failed (phase={outcome.phase}, exit={outcome.exit_code})"
        )

    # 3. Scope + run config for the attacker, pointing at the target's Service DNS.
    dialed_port = service_port if service_port is not None else target_port
    config_files = _emit_config(ctx, host=m.target_service_dns(engagement_id), port=dialed_port)

    return K8sProvision(
        config_files=config_files,
        target_image=destination,
        target_port=target_port,
        service_port=service_port,
    )


def _kaniko_context(repo_ref: str) -> str:
    """Turn a repo ref into a Kaniko build context URI.

    A ref that already carries a scheme (`git://…`, `https://…`, `dir://…`) is
    passed through; a bare `host/org/repo[#ref]` gets the `git://` prefix Kaniko
    uses for git contexts. Dockerfile repos only for MVP (compose deferred, §5)."""
    if "://" in repo_ref:
        return repo_ref
    return f"git://{repo_ref}"


def _emit_config(ctx: EngagementContext, *, host: str, port: int) -> Mapping[str, str]:
    """The ConfigMap payload: scope.yaml (target host+port) + run.toml (M6a-shaped)."""
    scope_yaml = f"target:\n  host: {host}\n  ports: [{port}]\n"
    run_toml = config_gen.render_run_config(ctx, _SCOPE_BASENAME, _POD_OUTPUT_DIR)
    return {_SCOPE_BASENAME: scope_yaml, "run.toml": run_toml}
