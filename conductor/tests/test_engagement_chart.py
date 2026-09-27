"""Render the per-engagement Helm chart and assert the security invariants (M9 Phase 1).

The chart (`deploy/helm/engagement/`) is the Helm form of the four workload
manifests the conductor used to build imperatively (target Pod + Service, attacker
Pod, run-config ConfigMap). This test renders it with `helm template` and asserts
the SAME load-bearing invariants that `test_k8s_manifests.py` asserts on the Python
builders, so the switch in Phase 3 cannot silently weaken them:

  - every Pod carries `runtimeClassName: gvisor` and `restartPolicy: Never`
  - the attacker's model key arrives via a `secretKeyRef` (name `model-key`), never
    an inlined env value
  - the target Service selects `role=target`
  - object names are fixed and unprefixed (`target`, `attacker`, `run-config`)

Skips when `helm` is not on PATH, so the suite stays green on a machine without it.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART_DIR = Path(__file__).resolve().parents[2] / "deploy" / "helm" / "engagement"

pytestmark = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm not on PATH"
)


def _render() -> dict[str, dict]:
    """`helm template` the chart with stand-in values; return objects by (kind, name)."""
    out = subprocess.run(
        [
            "helm",
            "template",
            "eng",
            str(CHART_DIR),
            "--namespace",
            "engagement-x",
            "--set",
            "engagementId=x",
            "--set",
            "target.image=nginx",
            "--set",
            "target.port=80",
            "--set",
            "attacker.image=curlimages/curl",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    objs: dict[tuple[str, str], dict] = {}
    for doc in yaml.safe_load_all(out.stdout):
        if doc:
            objs[(doc["kind"], doc["metadata"]["name"])] = doc
    return objs


@pytest.fixture(scope="module")
def objects() -> dict:
    return _render()


def test_lints():
    subprocess.run(["helm", "lint", str(CHART_DIR)], check=True, capture_output=True)


def test_renders_the_four_objects_unprefixed(objects):
    # Fixed, unprefixed names — no `{{ .Release.Name }}-` prefix (M6a DNS contract).
    assert ("Pod", "target") in objects
    assert ("Service", "target") in objects
    assert ("Pod", "attacker") in objects
    assert ("ConfigMap", "run-config") in objects


def test_every_pod_is_gvisor_and_run_once(objects):
    for (kind, _name), obj in objects.items():
        if kind == "Pod":
            spec = obj["spec"]
            assert spec["runtimeClassName"] == "gvisor"
            assert spec["restartPolicy"] == "Never"


def test_attacker_key_is_a_secret_ref_never_inlined(objects):
    container = objects[("Pod", "attacker")]["spec"]["containers"][0]
    (env,) = container["env"]
    assert env["name"] == "OPENROUTER_API_KEY"
    # The value arrives only by reference; there is no inlined `value`.
    assert "value" not in env
    ref = env["valueFrom"]["secretKeyRef"]
    assert ref["name"] == "model-key"
    assert ref["key"] == "OPENROUTER_API_KEY"


def test_target_has_no_key_and_no_config_mount(objects):
    container = objects[("Pod", "target")]["spec"]["containers"][0]
    assert "env" not in container
    assert "volumeMounts" not in container


def test_target_service_selects_role_target(objects):
    svc = objects[("Service", "target")]
    assert svc["spec"]["selector"] == {"engagement": "x", "role": "target"}


def test_labels_carry_engagement_id(objects):
    for obj in objects.values():
        assert obj["metadata"]["labels"]["engagement"] == "x"
