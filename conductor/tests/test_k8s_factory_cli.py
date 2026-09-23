"""Tests for the Phase B factory + CLI wiring (M6 step 5).

The factory is the one place the real kubernetes SDK is touched, so its failure
paths are what we can test safely without a cluster: a missing SDK, or the CLI
`--k8s` flag routing. Any test that would actually construct a client is guarded
to run ONLY when `kubernetes` is not importable, so it can never reach a real
cluster via a developer's kubeconfig.
"""

from __future__ import annotations

import importlib.util

import pytest

from autosploit_conductor.cli import _parse_args, main
from autosploit_conductor.context import ConductorError

_K8S_INSTALLED = importlib.util.find_spec("kubernetes") is not None
_needs_no_sdk = pytest.mark.skipif(
    _K8S_INSTALLED,
    reason="guards against contacting a real cluster; only meaningful without the SDK",
)


def test_k8s_flag_defaults_false():
    assert _parse_args(["run", "repo"]).k8s is False


def test_k8s_flag_parses_true():
    assert _parse_args(["run", "repo", "--k8s"]).k8s is True


@_needs_no_sdk
def test_factory_raises_conductor_error_without_sdk():
    from autosploit_conductor.k8s.factory import build_core_v1

    with pytest.raises(ConductorError) as exc:
        build_core_v1()
    assert "kubernetes" in str(exc.value).lower()


@_needs_no_sdk
def test_cli_k8s_path_reports_cleanly_without_sdk(capsys):
    # --k8s with no SDK: main catches the ConductorError and exits 1, no traceback.
    rc = main(["run", "some-repo", "--k8s"])
    assert rc == 1
    assert "conductor:" in capsys.readouterr().err


def test_phaseb_provision_is_not_implemented():
    # The M8 seam is honestly a stub; run_k8s turns this into failed(provision).
    from autosploit_conductor.context import EngagementContext
    from autosploit_conductor.k8s.provision import phaseb_provision

    ctx = EngagementContext(
        engagement_id="x", out_dir=__import__("pathlib").Path("."), repo_ref="r", timeout_s=1.0
    )
    with pytest.raises(NotImplementedError):
        phaseb_provision("repo", ctx)
