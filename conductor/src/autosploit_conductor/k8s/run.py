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

from autosploit_conductor.context import EngagementContext, make_context
from autosploit_conductor.k8s.client import CoreV1, EngagementCluster
from autosploit_conductor.k8s.watch import map_pod_result, watch_pod
from autosploit_conductor.launch import _redact
from autosploit_conductor.record import ProvisionOutcome, write_record
from autosploit_conductor.result import RunResult

_API_KEY_ENV = "OPENROUTER_API_KEY"
_ATTACKER_POD = "attacker"

# Placeholder harness image ref. Overridable per call; the real digest-pinned ref
# lands with the harness image pipeline (roadmap M5) and the engagement Helm chart
# (M9). Kept obvious so an unset image can't masquerade as a real one.
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


# The provision seam: `(repo_ref, ctx) -> K8sProvision`. Raising means the target
# never came up — a recorded failed(provision), not a crash (mirrors Phase A §8).
ProvisionFn = Callable[[str, EngagementContext], K8sProvision]


def run_k8s(
    repo_ref: str,
    api: CoreV1,
    *,
    provision: ProvisionFn,
    engagement_id: str | None = None,
    out_dir: Path | str = ".",
    api_key: str | None = None,
    attacker_image: str = _DEFAULT_ATTACKER_IMAGE,
    timeout_s: float | None = None,
    poll_interval_s: float = 2.0,
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
    cluster = EngagementCluster(api, ctx.engagement_id)

    provision_outcome = ProvisionOutcome(ok=False, error="provision never attempted")
    result: RunResult | None = None
    record_path: Path | None = None
    started_at = _now_iso()

    try:
        cluster.create_namespace()
        try:
            prov = provision(repo_ref, ctx)
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
                timeout_s=timeout_s if timeout_s is not None else ctx.timeout_s,
                poll_interval_s=poll_interval_s,
                now=now,
                sleep=sleep,
            )
    finally:
        _teardown(cluster)
        record_path = _write_record(ctx, provision_outcome, result, started_at)

    return result if result is not None else _internal_failure(), record_path


def _run_engagement(
    cluster: EngagementCluster,
    ctx: EngagementContext,
    prov: K8sProvision,
    *,
    attacker_image: str,
    api_key: str,
    timeout_s: float,
    poll_interval_s: float,
    now: Callable[[], float],
    sleep: Callable[[float], None],
) -> RunResult:
    """Deploy the target, launch the attacker, watch it, collect its logs."""
    # Target side (untrusted): Pod + Service. The Service DNS is the scope host
    # the provisioner emitted into scope.yaml (M6a / contract 1.1.0).
    cluster.create_target_pod(prov.target_image, container_port=prov.target_port)
    cluster.create_target_service(
        port=prov.service_port if prov.service_port is not None else prov.target_port,
        target_port=prov.target_port,
    )

    # Attacker side (trusted): Secret with the key, ConfigMap with the run files,
    # then the Pod that references both.
    cluster.apply_secret(api_key)
    cluster.apply_configmap(prov.config_files)
    cluster.create_attacker_pod(attacker_image)

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


def _teardown(cluster: EngagementCluster) -> None:
    """Delete the namespace — full teardown. Never masks the primary result (§8)."""
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
