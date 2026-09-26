"""End-to-end test of the Phase B orchestrator (M6 step 4).

Runs a whole engagement — namespace, target, attacker, watch, teardown, record —
against a fake CoreV1Api and a fake provision seam. No cluster, no waiting. This
is the M6 unit-level gate; the real-cluster run is the milestone's exit gate.
"""

from __future__ import annotations

import json

from autosploit_conductor.k8s.run import K8sProvision, run_k8s

REPO = "https://example.com/app.git"
KEY = "sk-or-v1-SECRETKEYVALUE"


class FakeCoreV1:
    """Fake API: records creates, tracks namespace existence, serves a terminal Pod."""

    def __init__(self, *, phase="Succeeded", exit_code=0, logs="turn1\nkey=" + KEY + "\n"):
        self.calls: list[str] = []
        self.namespaces: set[str] = set()
        self._phase = phase
        self._exit = exit_code
        self._logs = logs

    def create_namespace(self, body):
        self.calls.append("create_namespace")
        self.namespaces.add(body["metadata"]["name"])

    def delete_namespace(self, name):
        self.calls.append("delete_namespace")
        self.namespaces.discard(name)

    def create_namespaced_secret(self, namespace, body):
        self.calls.append("create_namespaced_secret")

    def create_namespaced_config_map(self, namespace, body):
        self.calls.append("create_namespaced_config_map")

    def create_namespaced_pod(self, namespace, body):
        self.calls.append(f"create_pod:{body['metadata']['name']}")

    def create_namespaced_service(self, namespace, body):
        self.calls.append("create_namespaced_service")

    def create_namespaced_custom_object(self, group, version, namespace, plural, body):
        self.calls.append(f"create_crd:{body['kind']}")

    def read_namespaced_pod(self, name, namespace):
        return {
            "status": {
                "phase": self._phase,
                "containerStatuses": [{"state": {"terminated": {"exitCode": self._exit}}}],
            }
        }

    def read_namespaced_pod_log(self, name, namespace):
        return self._logs


def _provision(files=None, image="img:built", port=3000):
    def fn(repo_ref, ctx, cluster):
        return K8sProvision(
            config_files=files or {"scope.yaml": "target: {host: svc}", "run.toml": "[model]\n"},
            target_image=image,
            target_port=port,
        )

    return fn


def _no_sleep(_s):  # watcher never sleeps when the Pod is terminal on first poll
    raise AssertionError("should not sleep on an already-terminal pod")


def test_full_engagement_complete(tmp_path):
    api = FakeCoreV1(phase="Succeeded", exit_code=0)
    result, _record_path = run_k8s(
        REPO,
        api,
        provision=_provision(),
        engagement_id="e1",
        out_dir=tmp_path,
        api_key=KEY,
        sleep=_no_sleep,
    )

    assert result.status == "complete"
    # Objects created in order: namespace, egress policy, target pod+service,
    # attacker secret/cm/pod.
    assert api.calls[0] == "create_namespace"
    assert api.calls[1] == "create_crd:CiliumNetworkPolicy"
    # The egress lockdown lands before the attacker Pod — no unpoliced window.
    assert api.calls.index("create_crd:CiliumNetworkPolicy") < api.calls.index(
        "create_pod:attacker"
    )
    assert "create_pod:target" in api.calls
    assert "create_namespaced_service" in api.calls
    assert "create_namespaced_secret" in api.calls
    assert "create_namespaced_config_map" in api.calls
    assert "create_pod:attacker" in api.calls
    # Teardown ran and the namespace is gone.
    assert api.calls[-1] == "delete_namespace"
    assert api.namespaces == set()


def test_record_written_and_report_status(tmp_path):
    api = FakeCoreV1(phase="Failed", exit_code=2)
    result, record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e2", out_dir=tmp_path,
        api_key=KEY, sleep=_no_sleep,
    )
    assert result.status == "partial"  # Failed pod, exit 2 -> clean halt
    assert record_path is not None
    data = json.loads(record_path.read_text())
    assert data["status"] == "partial"
    assert data["provision"]["ok"] is True


def test_attacker_logs_saved_and_key_redacted(tmp_path):
    api = FakeCoreV1()
    run_k8s(REPO, api, provision=_provision(), engagement_id="e3", out_dir=tmp_path,
            api_key=KEY, sleep=_no_sleep)
    log = (tmp_path / "e3" / "attacker.log").read_text()
    assert KEY not in log
    assert "***REDACTED***" in log


def test_failed_provision_skips_attacker_but_tears_down(tmp_path):
    api = FakeCoreV1()

    def boom(repo_ref, ctx, cluster):
        raise RuntimeError("target build failed")

    result, record_path = run_k8s(
        REPO, api, provision=boom, engagement_id="e4", out_dir=tmp_path,
        api_key=KEY, sleep=_no_sleep,
    )
    assert result.status == "failed"
    # Attacker was never launched...
    assert not any(c == "create_pod:attacker" for c in api.calls)
    # ...but the namespace was still created and torn down.
    assert "create_namespace" in api.calls
    assert api.calls[-1] == "delete_namespace"
    data = json.loads(record_path.read_text())
    assert data["provision"]["ok"] is False
    assert "target build failed" in data["provision"]["error"]


def test_network_policy_failure_aborts_fail_closed(tmp_path):
    # If egress can't be locked, the attacker must never launch (fail-closed), but
    # the namespace is still torn down.
    api = FakeCoreV1()

    def boom(group, version, namespace, plural, body):
        raise RuntimeError("cilium apiserver rejected the policy")

    api.create_namespaced_custom_object = boom  # type: ignore[method-assign]
    result, record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e7", out_dir=tmp_path,
        api_key=KEY, sleep=_no_sleep,
    )
    assert result.status == "failed"
    assert not any(c == "create_pod:attacker" for c in api.calls)
    assert not any(c == "create_pod:target" for c in api.calls)
    assert api.calls[-1] == "delete_namespace"


def test_api_key_resolved_from_env(tmp_path):
    api = FakeCoreV1()
    run_k8s(
        REPO, api, provision=_provision(), engagement_id="e5", out_dir=tmp_path,
        env={"OPENROUTER_API_KEY": KEY}, sleep=_no_sleep,
    )
    # Logs redacted using the env-resolved key proves it was picked up.
    log = (tmp_path / "e5" / "attacker.log").read_text()
    assert KEY not in log


def test_teardown_failure_does_not_mask_result(tmp_path):
    api = FakeCoreV1(phase="Succeeded", exit_code=0)

    def boom(name):
        raise RuntimeError("apiserver unreachable")

    api.delete_namespace = boom  # type: ignore[method-assign]
    result, record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e6", out_dir=tmp_path,
        api_key=KEY, sleep=_no_sleep,
    )
    # Teardown raised (a non-404), but the run's result and record still stand.
    assert result.status == "complete"
    assert record_path is not None
