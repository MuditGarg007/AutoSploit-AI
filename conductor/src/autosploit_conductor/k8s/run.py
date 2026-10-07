"""Phase B orchestrator — one engagement on the cluster (docs/orchestration.md §6).

M6 step 4. The Kubernetes twin of `run.py`: it owns one engagement end to end,
driving the `EngagementCluster` (step 2) and the watcher (step 3) instead of
subprocesses. Same contract as Phase A — `run_k8s` always returns
`(RunResult, record_path)`, with the record written on every terminal path so the
control plane distinguishes a halted run from a failed one via the record, not an
exit code (§8) — and the same key hygiene: `OPENROUTER_API_KEY` is resolved here,
handed only to the attacker's Secret, and never to the provisioner or to disk.

Two Phase-B-specific shapes:

- **Teardown is `delete_namespace`, nothing else.** Untrusted build output and the
  running target live in the cluster now, so deleting the namespace wipes them;
  the out-dir holds only `conductor.json` (the record — the one survivor, §4 [7]),
  so there is no `rmtree` dance. This also keeps Phase B independent of the Phase-A
  `teardown.py` (which imports the provisioner).
- **`provision` is an injected seam.** The real Phase-B provisioner (in-cluster
  Kaniko build of the target, roadmap M8) is not built yet; `run_k8s` takes a
  callable that returns the run files + target image/port, so the whole orchestrator
  is tested end to end against a fake cluster today and wired to the real
  provisioner at M8.
"""

from __future__ import annotations

import os
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from autosploit_conductor.context import EngagementContext, make_context
from autosploit_conductor.k8s import helm as _helm
from autosploit_conductor.k8s.client import CoreV1, CustomObjects, EngagementCluster
from autosploit_conductor.k8s.watch import map_pod_result, watch_pod
from autosploit_conductor.launch import _redact
from autosploit_conductor.record import ProvisionOutcome, write_record
from autosploit_conductor.result import RunResult

_API_KEY_ENV = "OPENROUTER_API_KEY"
_ATTACKER_POD = "attacker"

# Fixed Helm release name. The namespace is per-engagement (one release per
# namespace), so a stable, RFC1123-valid name is unambiguous — unlike the raw
# engagement id, which uses the wider docker-label charset.
_RELEASE_NAME = "engagement"

# The per-engagement chart (M9 Phase 1). run.py lives at
# conductor/src/autosploit_conductor/k8s/run.py, so the repo root is four parents up.
# The CLI resolves the effective dir (env override); this default keeps `run_k8s`
# usable directly in tests and scripts.
_DEFAULT_CHART_DIR = Path(__file__).resolve().parents[4] / "deploy" / "helm" / "engagement"


class HelmRunner(Protocol):
    """The helm seam `run_k8s` drives (k8s/helm.py in production, a fake in tests)."""

    def install_release(
        self, release: str, chart_dir: Path, namespace: str, values: Mapping[str, Any]
    ) -> None: ...

    def uninstall_release(self, release: str, namespace: str) -> None: ...

# Placeholder harness image ref. Overridable per call; the CLI supplies the real
# digest-pinned ref from the M5 release pipeline via AUTOSPLOIT_HARNESS_IMAGE
# (cli.py:_run_k8s). Kept obvious so an unset image can't masquerade as a real one.
_DEFAULT_ATTACKER_IMAGE = "ghcr.io/autosploit/harness:dev"


@dataclass(frozen=True, slots=True)
class K8sProvision:
    """What the provision step yields for a Phase B engagement.

    `config_files` is the ConfigMap payload mounted into the attacker (at least
    `scope.yaml` + `run.toml`); `target_image`/`target_port` deploy the target
    Pod; `service_port` is the port the attacker dials (defaults to the container
    port).
    """

    config_files: Mapping[str, str]
    target_image: str
    target_port: int
    service_port: int | None = None


# The provision seam: `(repo_ref, ctx, cluster) -> K8sProvision`. The real M8
# provisioner drives the cluster (registry deploy + Kaniko build) through the same
# `EngagementCluster` the orchestrator holds, so it is handed in. Raising means the
# target never came up — a recorded failed(provision), not a crash (mirrors §8).
ProvisionFn = Callable[[str, EngagementContext, EngagementCluster], K8sProvision]


def run_k8s(
    repo_ref: str,
    api: CoreV1,
    *,
    provision: ProvisionFn,
    custom: CustomObjects | None = None,
    engagement_id: str | None = None,
    out_dir: Path | str = ".",
    api_key: str | None = None,
    attacker_image: str = _DEFAULT_ATTACKER_IMAGE,
    helm: HelmRunner = _helm,
    chart_dir: Path = _DEFAULT_CHART_DIR,
    timeout_s: float | None = None,
    # The attacker watch is the longest poll loop in the system — it runs for the
    # whole (network-bound) attack phase, and every poll hits the already-busy
    # apiserver (capacity handoff B3). 5s over 2s shaves that churn; the only cost
    # is slightly slower terminal detection on a run that lasts minutes to an hour.
    poll_interval_s: float = 5.0,
    env: Mapping[str, str] | None = None,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[RunResult, Path | None]:
    """Run one engagement on the cluster and delete its namespace. Always records.

    `api` is an injected `CoreV1Api` (real client in production, fake in tests);
    `provision` is the seam that builds/deploys the target and returns the run
    files. `now`/`sleep` pass through to the watcher so tests run instantly.
    """
    if api_key is None:
        base = dict(os.environ) if env is None else dict(env)
        api_key = base.get(_API_KEY_ENV, "")

    ctx = make_context(repo_ref, engagement_id, out_dir, timeout_s=timeout_s or 3600.0)
    cluster = EngagementCluster(api, ctx.engagement_id, custom=custom)

    provision_outcome = ProvisionOutcome(ok=False, error="provision never attempted")
    result: RunResult | None = None
    record_path: Path | None = None
    started_at = _now_iso()

    try:
        cluster.create_namespace()
        # Fail-closed: lock the attacker's egress (M7 / SEAM-1) before anything
        # runs in the namespace. If the policy can't be applied, record a failed
        # outcome and skip provision/attacker entirely — never run unpoliced.
        try:
            cluster.apply_network_policy()
        except Exception as exc:  # noqa: BLE001 — a failed egress lockdown is a recorded, fail-closed outcome
            result = RunResult(
                status="failed",
                report_path=None,
                halt_reason=f"network policy: {exc}",
                exit_code=1,
            )
        else:
            try:
                prov = provision(repo_ref, ctx, cluster)
            except Exception as exc:  # noqa: BLE001 — a failed provision is a recorded outcome
                provision_outcome = ProvisionOutcome(ok=False, error=str(exc))
                result = RunResult(
                    status="failed", report_path=None, halt_reason=str(exc), exit_code=1
                )
            else:
                provision_outcome = ProvisionOutcome(ok=True, exit_code=0)
                result = _run_engagement(
                    cluster,
                    ctx,
                    prov,
                    attacker_image=attacker_image,
                    api_key=api_key,
                    helm=helm,
                    chart_dir=chart_dir,
                    timeout_s=timeout_s if timeout_s is not None else ctx.timeout_s,
                    poll_interval_s=poll_interval_s,
                    now=now,
                    sleep=sleep,
                )
    finally:
        _teardown(cluster, helm)
        record_path = _write_record(ctx, provision_outcome, result, started_at)

    return result if result is not None else _internal_failure(), record_path


def _run_engagement(
    cluster: EngagementCluster,
    ctx: EngagementContext,
    prov: K8sProvision,
    *,
    attacker_image: str,
    api_key: str,
    helm: HelmRunner,
    chart_dir: Path,
    timeout_s: float,
    poll_interval_s: float,
    now: Callable[[], float],
    sleep: Callable[[float], None],
) -> RunResult:
    """Install the engagement release, watch the attacker, collect its logs.

    The whole workload — target Pod + Service, attacker Pod, run-config ConfigMap —
    is one Helm release rendered from the per-engagement chart (M9). Only the model
    key stays imperative: the Secret is applied here so its value never enters the
    chart values file; the chart names it in a `secretKeyRef` only.
    """
    cluster.apply_secret(api_key)
    helm.install_release(
        _RELEASE_NAME,
        chart_dir,
        cluster.namespace,
        _chart_values(cluster.engagement_id, prov, attacker_image),
    )

    outcome = watch_pod(
        cluster,
        _ATTACKER_POD,
        timeout_s=timeout_s,
        poll_interval_s=poll_interval_s,
        now=now,
        sleep=sleep,
    )
    result = map_pod_result(outcome)

    # Collect the harness event stream BEFORE teardown deletes the namespace. Best
    # effort — a log-read failure never changes the run's lifecycle outcome.
    _collect_logs(cluster, ctx, api_key)
    return result


def _collect_logs(cluster: EngagementCluster, ctx: EngagementContext, api_key: str) -> None:
    """Save the attacker Pod's logs to the out-dir, key-scrubbed (§8). Best effort."""
    try:
        logs = cluster.pod_logs(_ATTACKER_POD)
    except Exception as exc:  # noqa: BLE001 — logs are diagnostics, not the result
        print(f"conductor: could not read attacker logs: {exc}", file=sys.stderr, flush=True)
        return
    try:
        (ctx.out_dir / "attacker.log").write_text(_redact(logs, api_key), encoding="utf-8")
    except OSError as exc:
        print(f"conductor: could not write attacker logs: {exc}", file=sys.stderr, flush=True)


def _chart_values(
    engagement_id: str, prov: K8sProvision, attacker_image: str
) -> dict[str, Any]:
    """Build the Helm values for one engagement from the provision result.

    `target.port` is the Service port the attacker dials (the scope port);
    `target.targetPort` is the container port behind it. The model key is NOT here —
    it rides the imperatively-applied Secret the chart references. Secret name/key,
    mount path and run-config basename take the chart defaults (they mirror the
    `k8s/manifests.py` constants).
    """
    service_port = prov.service_port if prov.service_port is not None else prov.target_port
    return {
        "engagementId": engagement_id,
        "target": {
            "image": prov.target_image,
            "port": service_port,
            "targetPort": prov.target_port,
        },
        "attacker": {"image": attacker_image},
        "runConfig": {"files": dict(prov.config_files)},
    }


def _teardown(cluster: EngagementCluster, helm: HelmRunner) -> None:
    """Uninstall the release, then delete the namespace — full teardown.

    Both steps are best-effort and never mask the primary result (§8). The
    namespace delete alone wipes the workload; the `helm uninstall` keeps Helm's
    own release bookkeeping clean (and is a no-op the caller swallows if the
    release was never installed — e.g. a failed provision).
    """
    try:
        helm.uninstall_release(_RELEASE_NAME, cluster.namespace)
    except Exception as exc:  # noqa: BLE001 — teardown must not mask the result
        print(f"conductor: helm uninstall failed: {exc}", file=sys.stderr, flush=True)
    try:
        cluster.delete_namespace()
    except Exception as exc:  # noqa: BLE001 — teardown must not mask the result
        print(f"conductor: namespace teardown failed: {exc}", file=sys.stderr, flush=True)


def _write_record(
    ctx: EngagementContext,
    provision: ProvisionOutcome,
    result: RunResult | None,
    started_at: str,
) -> Path | None:
    """Write conductor.json into the out-dir (the record survives teardown). None on failure."""
    try:
        ctx.out_dir.mkdir(parents=True, exist_ok=True)
        return write_record(
            ctx, provision, result, started_at=started_at, finished_at=_now_iso()
        )
    except OSError:
        return None


def _internal_failure() -> RunResult:
    """The result when the try body raised before producing one (namespace create failed)."""
    return RunResult(status="failed", report_path=None, halt_reason="internal error", exit_code=1)


def _now_iso() -> str:
    """ISO-8601 UTC timestamp, mirroring record._now_iso (§4 [7])."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
