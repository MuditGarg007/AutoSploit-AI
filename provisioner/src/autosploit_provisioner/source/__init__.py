"""source — resolve a repo reference (docs/provisioner.md §4 row 1, M2).

Repo ref (git URL | local path | prebuilt image) → a `Source` (workdir + commit
sha, or an image ref). Token hygiene is load-bearing: the clone token is read
from env only, injected in-memory, and never written to the manifest, logs, or
the workdir; any subprocess error is redacted before it is surfaced (§8).
"""
