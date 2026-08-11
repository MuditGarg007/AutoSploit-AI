"""C1 tests — engagement-id validation + out-dir creation (docs/conductor.md C1).

Pure, no subprocess, no Docker: bad ids rejected, good ids pass, the out-dir is
created under the requested base, and a generated id is safe as a label/dir name.
"""

from __future__ import annotations

import re

import pytest

from autosploit_conductor.context import (
    ContextError,
    EngagementContext,
    make_context,
    validate_engagement_id,
)


def test_bad_ids_rejected() -> None:
    """"../x", "has space", and empty ids must all raise ContextError (§8)."""
    for bad in ("../x", "has space", "", "a/b", "a:b", "a\\b", "a\nb"):
        with pytest.raises(ContextError):
            validate_engagement_id(bad)


def test_good_ids_pass() -> None:
    """Charset [a-zA-Z0-9_.-] — dots, underscores, dashes are legal."""
    for good in ("juiceshop", "eng-1", "eng_1", "eng.1", "a1B2"):
        validate_engagement_id(good)  # must not raise


def test_make_context_creates_out_dir(tmp_path) -> None:
    ctx = make_context("https://github.com/acme/juice-shop", "eng-1", out_dir=tmp_path)
    assert isinstance(ctx, EngagementContext)
    assert ctx.engagement_id == "eng-1"
    assert ctx.out_dir == tmp_path / "eng-1"
    assert ctx.out_dir.is_dir()
    assert ctx.repo_ref == "https://github.com/acme/juice-shop"
    assert ctx.timeout_s == 3600.0


def test_make_context_nested_id_creates_dir(tmp_path) -> None:
    ctx = make_context("repo", "a.b-c_1", out_dir=tmp_path)
    assert ctx.out_dir == tmp_path / "a.b-c_1"
    assert ctx.out_dir.is_dir()


def test_make_context_generated_id_is_safe(tmp_path) -> None:
    ctx = make_context("repo", None, out_dir=tmp_path)
    assert re.fullmatch(r"[a-zA-Z0-9_.-]+", ctx.engagement_id)
    assert ctx.out_dir.is_dir()


def test_make_context_rejects_bad_id(tmp_path) -> None:
    with pytest.raises(ContextError):
        make_context("repo", "../x", out_dir=tmp_path)
