"""End-to-end test of the Phase B orchestrator (M6 step 4, M9 chart install).

Runs a whole engagement — namespace, egress lockdown, secret, chart install,
watch, teardown, record — against a fake CoreV1Api and a fake Helm runner. No
cluster, no helm binary, no waiting. Since M9 Phase 3 the target/attacker/config
workload is one Helm release, so the orchestrator's contract with the cluster is:
apply the egress policy + the model Secret imperatively, hand everything else to
`helm.install_release`, and on every terminal path `helm.uninstall_release` then
delete the namespace. This is the M6/M9 unit-level gate; the real-cluster run is
the milestone's exit gate (scripts/m9-proof.sh).
"""

from __future__ import annotations

import json

from autosploit_conductor.k8s.run import _RELEASE_NAME, K8sProvision, run_k8s

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


class FakeHelm:
    """Helm seam stand-in: records install/uninstall args; installs nothing."""

    def __init__(self):
        self.installs: list[tuple[str, str, str, dict]] = []
        self.uninstalls: list[tuple[str, str]] = []

    def install_release(self, release, chart_dir, namespace, values):
        self.installs.append((release, str(chart_dir), namespace, dict(values)))

    def uninstall_release(self, release, namespace):
        self.uninstalls.append((release, namespace))


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


def test_full_engagement_installs_chart_and_tears_down(tmp_path):
    api = FakeCoreV1(phase="Succeeded", exit_code=0)
    helm = FakeHelm()
    result, _record_path = run_k8s(
        REPO,
        api,
        provision=_provision(),
        engagement_id="e1",
        out_dir=tmp_path,
        api_key=KEY,
        helm=helm,
        sleep=_no_sleep,
    )

    assert result.status == "complete"
    # Imperative pre-install steps, in order: namespace, egress policy, model Secret.
    assert api.calls[0] == "create_namespace"
    assert api.calls[1] == "create_crd:CiliumNetworkPolicy"
    assert "create_namespaced_secret" in api.calls
    # The whole workload is one Helm release — the conductor no longer creates the
    # target Pod/Service or the run-config ConfigMap imperatively.
    assert "create_pod:target" not in api.calls
    assert "create_pod:attacker" not in api.calls
    assert "create_namespaced_service" not in api.calls

    # The release install carried the right name/namespace and values built from
    # the provision result. The Secret is applied before install (never in values).
    assert len(helm.installs) == 1
    release, _chart, namespace, values = helm.installs[0]
    assert release == _RELEASE_NAME
    assert namespace == "engagement-e1"
    assert values["engagementId"] == "e1"
    assert values["target"] == {"image": "img:built", "port": 3000, "targetPort": 3000}
    assert values["attacker"]["image"]  # the harness image ref
    assert set(values["runConfig"]["files"]) == {"scope.yaml", "run.toml"}
    assert KEY not in json.dumps(values)  # the model key never enters the values file
    assert api.calls.index("create_namespaced_secret") < api.calls.index("delete_namespace")

    # Teardown: uninstall the release, then delete the namespace; ns is gone.
    assert helm.uninstalls == [(_RELEASE_NAME, "engagement-e1")]
    assert api.calls[-1] == "delete_namespace"
    assert api.namespaces == set()


def test_attacker_image_flows_to_chart_values(tmp_path):
    # A digest-pinned harness ref passed to run_k8s reaches the chart's attacker.image.
    api = FakeCoreV1(phase="Succeeded", exit_code=0)
    helm = FakeHelm()
    digest = "ghcr.io/autosploit/harness@sha256:" + "b" * 64
    run_k8s(
        REPO,
        api,
        provision=_provision(),
        engagement_id="e1",
        out_dir=tmp_path,
        api_key=KEY,
        helm=helm,
        sleep=_no_sleep,
        attacker_image=digest,
    )
    _release, _chart, _namespace, values = helm.installs[0]
    assert values["attacker"]["image"] == digest


def test_service_port_override_maps_to_target_values(tmp_path):
    api = FakeCoreV1()
    helm = FakeHelm()

    def prov(repo_ref, ctx, cluster):
        # Service port distinct from the container port.
        return K8sProvision(
            config_files={"run.toml": "[model]\n"},
            target_image="img:built",
            target_port=8080,
            service_port=80,
        )

    run_k8s(REPO, api, provision=prov, engagement_id="e0", out_dir=tmp_path,
            api_key=KEY, helm=helm, sleep=_no_sleep)
    _r, _c, _n, values = helm.installs[0]
    assert values["target"] == {"image": "img:built", "port": 80, "targetPort": 8080}


def test_record_written_and_report_status(tmp_path):
    api = FakeCoreV1(phase="Failed", exit_code=2)
    helm = FakeHelm()
    result, record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e2", out_dir=tmp_path,
        api_key=KEY, helm=helm, sleep=_no_sleep,
    )
    assert result.status == "partial"  # Failed pod, exit 2 -> clean halt
    assert record_path is not None
    data = json.loads(record_path.read_text())
    assert data["status"] == "partial"
    assert data["provision"]["ok"] is True
    # Terminal path: release installed then uninstalled, namespace deleted.
    assert len(helm.installs) == 1
    assert helm.uninstalls == [(_RELEASE_NAME, "engagement-e2")]
    assert api.calls[-1] == "delete_namespace"


def test_attacker_logs_saved_and_key_redacted(tmp_path):
    api = FakeCoreV1()
    helm = FakeHelm()
    run_k8s(REPO, api, provision=_provision(), engagement_id="e3", out_dir=tmp_path,
            api_key=KEY, helm=helm, sleep=_no_sleep)
    log = (tmp_path / "e3" / "attacker.log").read_text()
    assert KEY not in log
    assert "***REDACTED***" in log


def test_failed_provision_skips_install_but_tears_down(tmp_path):
    api = FakeCoreV1()
    helm = FakeHelm()

    def boom(repo_ref, ctx, cluster):
        raise RuntimeError("target build failed")

    result, record_path = run_k8s(
        REPO, api, provision=boom, engagement_id="e4", out_dir=tmp_path,
        api_key=KEY, helm=helm, sleep=_no_sleep,
    )
    assert result.status == "failed"
    # The release was never installed...
    assert helm.installs == []
    # ...but teardown still ran best-effort (uninstall + namespace delete).
    assert helm.uninstalls == [(_RELEASE_NAME, "engagement-e4")]
    assert "create_namespace" in api.calls
    assert api.calls[-1] == "delete_namespace"
    data = json.loads(record_path.read_text())
    assert data["provision"]["ok"] is False
    assert "target build failed" in data["provision"]["error"]


def test_timeout_still_tears_down(tmp_path):
    # A never-terminal Pod trips the wall-clock timeout; the release is still
    # uninstalled and the namespace deleted (terminal path: timeout).
    api = FakeCoreV1(phase="Running")
    helm = FakeHelm()
    result, _record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="et", out_dir=tmp_path,
        api_key=KEY, helm=helm, timeout_s=0.0, now=lambda: 0.0, sleep=_no_sleep,
    )
    assert result.status == "partial"  # timeout -> clean halt with a record
    assert len(helm.installs) == 1
    assert helm.uninstalls == [(_RELEASE_NAME, "engagement-et")]
    assert api.calls[-1] == "delete_namespace"


def test_network_policy_failure_aborts_fail_closed(tmp_path):
    # If egress can't be locked, nothing may be installed (fail-closed), but the
    # namespace is still torn down.
    api = FakeCoreV1()
    helm = FakeHelm()

    def boom(group, version, namespace, plural, body):
        raise RuntimeError("cilium apiserver rejected the policy")

    api.create_namespaced_custom_object = boom  # type: ignore[method-assign]
    result, _record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e7", out_dir=tmp_path,
        api_key=KEY, helm=helm, sleep=_no_sleep,
    )
    assert result.status == "failed"
    assert helm.installs == []
    assert "create_namespaced_secret" not in api.calls
    assert api.calls[-1] == "delete_namespace"


def test_api_key_resolved_from_env(tmp_path):
    api = FakeCoreV1()
    helm = FakeHelm()
    run_k8s(
        REPO, api, provision=_provision(), engagement_id="e5", out_dir=tmp_path,
        env={"OPENROUTER_API_KEY": KEY}, helm=helm, sleep=_no_sleep,
    )
    # Logs redacted using the env-resolved key proves it was picked up.
    log = (tmp_path / "e5" / "attacker.log").read_text()
    assert KEY not in log


def test_teardown_failure_does_not_mask_result(tmp_path):
    api = FakeCoreV1(phase="Succeeded", exit_code=0)
    helm = FakeHelm()

    def boom(name):
        raise RuntimeError("apiserver unreachable")

    api.delete_namespace = boom  # type: ignore[method-assign]
    result, record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e6", out_dir=tmp_path,
        api_key=KEY, helm=helm, sleep=_no_sleep,
    )
    # Teardown raised (a non-404), but the run's result and record still stand.
    assert result.status == "complete"
    assert record_path is not None


def test_helm_uninstall_failure_does_not_mask_result(tmp_path):
    # A best-effort uninstall that raises must not change the result, and the
    # namespace delete still runs after it.
    api = FakeCoreV1(phase="Succeeded", exit_code=0)
    helm = FakeHelm()

    def boom(release, namespace):
        raise RuntimeError("helm release not found")

    helm.uninstall_release = boom  # type: ignore[method-assign]
    result, _record_path = run_k8s(
        REPO, api, provision=_provision(), engagement_id="e8", out_dir=tmp_path,
        api_key=KEY, helm=helm, sleep=_no_sleep,
    )
    assert result.status == "complete"
    assert api.calls[-1] == "delete_namespace"  # ns delete ran despite the uninstall raise
