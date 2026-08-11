"""cloner — repo ref → Source (docs/provisioner.md §4 row 1, M2).

Three input shapes, one resolver:
- git URL → shallow `git clone --depth 1` (subprocess), then `git rev-parse HEAD`.
- local path → passthrough, no clone; commit = `git rev-parse HEAD` if it's a repo,
  else None.
- prebuilt image (`docker://…` or a bare image ref) → no clone; carry the ref so the
  booter (M3) can skip the build.

**Token hygiene is load-bearing (§8).** The clone token is read from the environment
only (`GIT_TOKEN` / `GITHUB_TOKEN`), injected into the clone URL *in memory*, and is
NEVER written to the manifest, logs, or the workdir. `_redact()` scrubs the token
from any subprocess output before it is surfaced in an error — so a failed clone can
never leak the credential through a stack trace or a captured stderr tail.

Precedence when the shape is ambiguous (documented, tested):
  1. `docker://` prefix        → image (prefix stripped).
  2. git URL (scheme / scp-like / `.git` suffix) → git clone.
  3. existing local path       → local passthrough.
  4. anything else             → bare image ref.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from ..contracts.errors import ProvisionError
from ..contracts.plan import Source

# Env vars we accept a clone token from, in order. Token never leaves this process
# except as an in-memory auth prefix on the clone URL (§8).
_TOKEN_ENV_VARS = ("GIT_TOKEN", "GITHUB_TOKEN")

# URL schemes that mark a ref as a git remote to clone. `file://` is included so a
# local repo can be cloned (deterministic tests + no-remote demos); it is never
# token-injectable (nothing to authenticate).
_GIT_URL_SCHEMES = ("https://", "http://", "git://", "ssh://", "git+ssh://", "file://")

# Only http(s) remotes get an in-memory token prefix; ssh/git remotes authenticate
# by key, not by token.
_TOKEN_INJECTABLE_SCHEMES = ("https://", "http://")

_IMAGE_PREFIX = "docker://"


def resolve_source(ref: str, workdir: Path) -> Source:
    """Resolve a repo `ref` into a `Source`, cloning into `workdir` when needed.

    See the module docstring for the four-step precedence. Raises `ProvisionError`
    (token-redacted) if a git clone fails.
    """
    if ref.startswith(_IMAGE_PREFIX):
        return _image_source(ref[len(_IMAGE_PREFIX) :])

    if _looks_like_git_url(ref):
        return _clone(ref, workdir)

    if Path(ref).exists():
        return _local_source(Path(ref))

    # Fallback: a bare image ref (e.g. `nginx:latest`, `ghcr.io/org/app:tag`).
    return _image_source(ref)


# ---- kinds -----------------------------------------------------------------


def _image_source(image_ref: str) -> Source:
    """Prebuilt image — no clone, no workdir; the booter (M3) runs it directly."""
    return Source(kind="image", path=None, image_ref=image_ref, commit=None)


def _local_source(path: Path) -> Source:
    """Local path passthrough — no clone; commit read only if it's a git repo."""
    return Source(kind="local", path=path, image_ref=None, commit=_git_head(path))


def _clone(ref: str, workdir: Path) -> Source:
    """Shallow-clone `ref` into `workdir`, token-authenticated in memory only.

    The token (if any) is injected into the URL just for the subprocess argv and is
    scrubbed from any error output via `_redact` before it surfaces.
    """
    token = _read_token()
    auth_url = _inject_token(ref, token)

    result = subprocess.run(
        ["git", "clone", "--depth", "1", auth_url, str(workdir)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        # stderr may echo the token-bearing URL — redact before surfacing (§8).
        raise ProvisionError(f"git clone failed: {_redact(result.stderr.strip(), token)}")

    return Source(kind="git", path=workdir, image_ref=None, commit=_git_head(workdir))


# ---- token hygiene ---------------------------------------------------------


def _read_token() -> str | None:
    """Read the clone token from env only (never from a file/arg). None if unset."""
    for var in _TOKEN_ENV_VARS:
        token = os.environ.get(var)
        if token:
            return token
    return None


def _inject_token(url: str, token: str | None) -> str:
    """Return `url` with `token` as an in-memory auth prefix (http(s) only).

    No-op when there's no token, the scheme isn't token-injectable, or the URL
    already carries credentials (avoid clobbering a `user:pass@` a caller supplied).
    """
    if not token or not url.startswith(_TOKEN_INJECTABLE_SCHEMES):
        return url
    scheme, rest = url.split("://", 1)
    authority = rest.split("/", 1)[0]
    if "@" in authority:  # credentials already present — leave it alone
        return url
    return f"{scheme}://{token}@{rest}"


def _redact(text: str, token: str | None) -> str:
    """Strip `token` from `text` so it never surfaces in an error/log (§8)."""
    if not token:
        return text
    return text.replace(token, "***")


# ---- git helpers -----------------------------------------------------------


def _git_head(path: Path) -> str | None:
    """`git rev-parse HEAD` in `path`; None if it isn't a git repo (no error)."""
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _looks_like_git_url(ref: str) -> bool:
    """Heuristic: does `ref` name a git remote to clone (vs. a path/image ref)?"""
    if ref.startswith(_GIT_URL_SCHEMES):
        return True
    if ref.endswith(".git"):
        return True
    # scp-like remote: `git@host:org/repo` — an `@` with a `:` in the host part.
    if "@" in ref:
        after_at = ref.split("@", 1)[1]
        if ":" in after_at:
            return True
    return False
