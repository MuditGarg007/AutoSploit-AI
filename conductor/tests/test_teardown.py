"""C4 tests — teardown: zero residue, idempotent (docs/conductor.md C4).

The container half of teardown is delegated to the provisioner's own
rm-by-label (which needs a live Docker daemon — exercised for real in C6), so
these tests drive the container half through a fake `container_teardown`
callable. What is proven deterministically here is the conductor's own half:
the engagement out-dir is always removed, teardown is idempotent (second call
is a no-op, not an error), registration is de-duplicated per engagement, and a
failing container half still removes the out-dir (§8, "teardown must run no
matter what").
"""

from __future__ import annotations

from pathlib import Path

from autosploit_conductor.context import make_context
from autosploit_conductor.teardown import register, teardown_run


def _ctx(tmp_path: Path, engagement_id: str = "eng-1"):
    return make_context("https://github.com/acme/juice-shop", engagement_id, out_dir=tmp_path)


def _seed_out_dir(ctx) -> None:
    """Put a target-owned file in the out-dir (as the provisioner/harness would)."""
    (ctx.out_dir / "scope.yaml").write_text("target: {host: 127.0.0.1, ports: [3000]}\n", encoding="utf-8")


def test_teardown_removes_out_dir(tmp_path: Path) -> None:
    """A run's own workdir must be gone after teardown — zero residue."""
    ctx = _ctx(tmp_path)
    _seed_out_dir(ctx)
    calls: list[tuple[str, str | None]] = []

    def fake_container(engagement_id: str, workdir: Path | None) -> None:
        calls.append((engagement_id, str(workdir) if workdir else None))

    teardown_run(ctx, container_teardown=fake_container)

    assert not ctx.out_dir.exists()
    # The container half was asked to clean exactly this engagement, pointing at
    # our out-dir (the provisioner's workdir half, belt + braces).
    assert calls == [("eng-1", str(ctx.out_dir))]


def test_teardown_idempotent_second_call_noop(tmp_path: Path) -> None:
    """A second teardown must be a no-op, not an error (§4 [6], C4 gate)."""
    ctx = _ctx(tmp_path)
    _seed_out_dir(ctx)

    teardown_run(ctx, container_teardown=lambda e, w: None)
    teardown_run(ctx, container_teardown=lambda e, w: None)

    assert not ctx.out_dir.exists()


def test_teardown_noops_on_missing_out_dir(tmp_path: Path) -> None:
    """A missing out-dir is the success state, never an error."""
    ctx = _ctx(tmp_path)

    teardown_run(ctx, container_teardown=lambda e, w: None)  # must not raise

    assert not ctx.out_dir.exists()


def test_teardown_removes_out_dir_even_if_container_half_fails(tmp_path: Path) -> None:
    """Teardown must never mask the primary result — out-dir goes even on error."""
    ctx = _ctx(tmp_path)
    _seed_out_dir(ctx)

    def failing_container(engagement_id: str, workdir: Path | None) -> None:
        raise RuntimeError("docker daemon unreachable")

    teardown_run(ctx, container_teardown=failing_container)

    assert not ctx.out_dir.exists()


def test_register_idempotent_and_runs_on_atexit(tmp_path: Path) -> None:
    """register() must dedupe per engagement and fire the teardown at exit."""
    ctx = _ctx(tmp_path)
    _seed_out_dir(ctx)

    register(ctx, container_teardown=lambda e, w: None)
    register(ctx, container_teardown=lambda e, w: None)  # same engagement: no-op

    import atexit

    atexit._run_exitfuncs()  # simulate interpreter exit

    assert not ctx.out_dir.exists()


def test_rmtree_retry_clears_transient_lock(tmp_path: Path, monkeypatch) -> None:
    """A transient lock (Windows git pack file) must not leak residue — the
    removal retries until the lock clears (C6: zero residue)."""
    import shutil as shutil_mod

    import autosploit_conductor.teardown as teardown_mod

    ctx = _ctx(tmp_path)
    _seed_out_dir(ctx)

    real_rmtree = shutil_mod.rmtree
    calls = {"n": 0}

    def flaky_rmtree(path, *, ignore_errors):
        calls["n"] += 1
        if calls["n"] < 3:  # lock clears on the 3rd attempt
            return  # simulate failure: dir still there
        return real_rmtree(path, ignore_errors=ignore_errors)

    monkeypatch.setattr(teardown_mod.shutil, "rmtree", flaky_rmtree)

    teardown_run(ctx, container_teardown=lambda e, w: None)

    assert calls["n"] >= 3  # retried until the lock cleared
    assert not ctx.out_dir.exists()
