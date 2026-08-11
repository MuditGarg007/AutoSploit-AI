"""M2 gate (docs/provisioner.md §11 M2): cloner shapes + token hygiene.

Pure/Docker-free by default. The one real-network clone is opt-in
(`@pytest.mark.integration`). The redaction path is proven deterministically by
monkeypatching `subprocess.run` — no flaky DNS — so the load-bearing assertion
"the token appears in no surfaced output" (§8) always runs in the fast suite.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from autosploit_provisioner.contracts.errors import ProvisionError
from autosploit_provisioner.contracts.plan import Source
from autosploit_provisioner.source import cloner
from autosploit_provisioner.source.cloner import (
    _inject_token,
    _looks_like_git_url,
    _redact,
    resolve_source,
)

_TOKEN = "ghp_FAKE_SECRET_TOKEN_abc123"


# ---- helpers ---------------------------------------------------------------


def _init_repo(path: Path) -> str:
    """Init a git repo at `path` with one commit; return its HEAD sha."""
    env_args = [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
    ]
    subprocess.run(["git", "init", str(path)], capture_output=True, check=True)
    subprocess.run(
        ["git", "-C", str(path), *env_args, "commit", "--allow-empty", "-m", "init"],
        capture_output=True,
        check=True,
    )
    head = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    )
    return head.stdout.strip()


# ---- redaction (the load-bearing assertion, §8) ----------------------------


def test_redact_strips_token() -> None:
    text = f"fatal: could not read from https://{_TOKEN}@github.com/x/y"
    out = _redact(text, _TOKEN)
    assert _TOKEN not in out
    assert "***" in out


def test_redact_none_token_is_noop() -> None:
    assert _redact("no secret here", None) == "no secret here"


def test_clone_error_redacts_token(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Token is injected into argv (in memory) but scrubbed from the surfaced error."""
    monkeypatch.setenv("GIT_TOKEN", _TOKEN)
    captured_argv: list[str] = []

    def fake_run(argv, *args, **kwargs):  # type: ignore[no-untyped-def]
        captured_argv.extend(argv)
        # git echoes the token-bearing URL back in stderr on failure.
        return subprocess.CompletedProcess(
            argv, returncode=128, stdout="", stderr=f"fatal: repo not found {argv[4]}"
        )

    monkeypatch.setattr(cloner.subprocess, "run", fake_run)

    with pytest.raises(ProvisionError) as exc:
        resolve_source("https://github.com/x/y.git", tmp_path)

    # Token WAS used in-memory for the clone...
    assert any(_TOKEN in arg for arg in captured_argv)
    # ...but NEVER appears in what the caller/logs see.
    assert _TOKEN not in str(exc.value)
    assert "***" in str(exc.value)


def test_token_read_from_env_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No token in env → clone URL carries no credential (nothing to leak)."""
    monkeypatch.delenv("GIT_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    captured_argv: list[str] = []

    def fake_run(argv, *args, **kwargs):  # type: ignore[no-untyped-def]
        captured_argv.extend(argv)
        return subprocess.CompletedProcess(argv, returncode=128, stdout="", stderr="boom")

    monkeypatch.setattr(cloner.subprocess, "run", fake_run)

    with pytest.raises(ProvisionError):
        resolve_source("https://github.com/x/y.git", tmp_path)

    assert not any("@" in arg for arg in captured_argv)


# ---- token injection -------------------------------------------------------


def test_inject_token_https() -> None:
    assert (
        _inject_token("https://github.com/x/y.git", _TOKEN)
        == f"https://{_TOKEN}@github.com/x/y.git"
    )


def test_inject_token_no_token_noop() -> None:
    assert _inject_token("https://github.com/x/y.git", None) == "https://github.com/x/y.git"


def test_inject_token_ssh_noop() -> None:
    assert _inject_token("git@github.com:x/y.git", _TOKEN) == "git@github.com:x/y.git"


def test_inject_token_existing_creds_noop() -> None:
    url = "https://user:pass@github.com/x/y.git"
    assert _inject_token(url, _TOKEN) == url


# ---- git-url detection -----------------------------------------------------


@pytest.mark.parametrize(
    "ref",
    [
        "https://github.com/x/y.git",
        "http://example.com/x/y",
        "git://example.com/x/y",
        "ssh://git@example.com/x/y",
        "git@github.com:x/y.git",
        "example.com/x/y.git",
        "file:///tmp/x/y",
    ],
)
def test_looks_like_git_url_true(ref: str) -> None:
    assert _looks_like_git_url(ref) is True


@pytest.mark.parametrize(
    "ref",
    [
        r"C:\Users\me\repo",
        "/home/me/repo",
        "./repo",
        "repo",
        "nginx:latest",
        "ghcr.io/org/app:tag",
    ],
)
def test_looks_like_git_url_false(ref: str) -> None:
    assert _looks_like_git_url(ref) is False


# ---- image-ref detection ---------------------------------------------------


def test_docker_prefix_is_image(tmp_path: Path) -> None:
    src = resolve_source("docker://nginx:latest", tmp_path)
    assert src == Source(kind="image", path=None, image_ref="nginx:latest", commit=None)


def test_bare_ref_is_image(tmp_path: Path) -> None:
    """A non-path, non-URL ref falls through to a bare image ref."""
    src = resolve_source("ghcr.io/org/app:tag", tmp_path)
    assert src.kind == "image"
    assert src.image_ref == "ghcr.io/org/app:tag"
    assert src.path is None


# ---- local-path passthrough ------------------------------------------------


def test_local_repo_passthrough_reads_commit(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    head = _init_repo(repo)

    src = resolve_source(str(repo), tmp_path)

    assert src.kind == "local"
    assert src.path == repo
    assert src.image_ref is None
    assert src.commit == head


def test_local_nonrepo_has_no_commit(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()

    src = resolve_source(str(plain), tmp_path)

    assert src.kind == "local"
    assert src.path == plain
    assert src.commit is None


# ---- real network clone (opt-in) -------------------------------------------


@pytest.mark.integration
def test_real_shallow_clone(tmp_path: Path) -> None:
    """Opt-in: a real shallow clone of a tiny public repo yields a commit sha."""
    dest = tmp_path / "clone"
    src = resolve_source("https://github.com/octocat/Hello-World.git", dest)

    assert src.kind == "git"
    assert src.path == dest
    assert src.commit is not None and len(src.commit) == 40
    assert (dest / ".git").exists()
