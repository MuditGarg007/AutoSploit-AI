"""M5 gate (docs/provisioner.md §11 M5): the emitted scope parses through the harness.

Pure — no Docker. The load-bearing seam test (§3, §11 "non-negotiable"): a scope
written by `emit_scope` is round-tripped through the *real* harness `load_scope` and
must reconstruct the same `ScopeAllowlist(host, ports)`. Also asserts an empty-ports
emit is rejected fail-closed and leaves no file behind.
"""

from __future__ import annotations

import pytest
import yaml
from autosploit_harness.contracts.scope import ScopeAllowlist
from autosploit_harness.driver.config import load_scope

from autosploit_provisioner.contracts.errors import ScopeValidationFailed
from autosploit_provisioner.emit import emit_scope


def test_roundtrips_through_harness_load_scope(tmp_path):
    out = tmp_path / "scope.yaml"

    returned = emit_scope("127.0.0.1", [3000], out)

    assert returned == out
    # Gate: the harness's own parser is the acceptance test for the file.
    assert load_scope(out) == ScopeAllowlist(host="127.0.0.1", ports=(3000,))


def test_roundtrips_multiple_ports(tmp_path):
    out = tmp_path / "scope.yaml"

    emit_scope("127.0.0.1", [8080, 3000], out)

    assert load_scope(out) == ScopeAllowlist(host="127.0.0.1", ports=(8080, 3000))


def test_coerces_ports_to_int(tmp_path):
    out = tmp_path / "scope.yaml"

    emit_scope("127.0.0.1", ["3000"], out)

    # Emitted YAML carries real ints, not strings (the harness would int() them anyway).
    raw = yaml.safe_load(out.read_text(encoding="utf-8"))
    assert raw["target"]["ports"] == [3000]
    assert load_scope(out) == ScopeAllowlist(host="127.0.0.1", ports=(3000,))


def test_empty_ports_rejected_and_no_file_left(tmp_path):
    out = tmp_path / "scope.yaml"

    with pytest.raises(ScopeValidationFailed):
        emit_scope("127.0.0.1", [], out)

    assert not out.exists()  # fail-closed: no unparseable scope left for the conductor
