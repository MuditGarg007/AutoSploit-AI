"""contracts — THE SEAMS (docs/provisioner.md §3, §4). Frozen shapes, no logic.

The shapes the slices agree on live here once and stay frozen: the resolved
source, the build plan, the final provision result, and the error root every
slice raises through. Every slice imports from here; nothing here imports a
slice. This one-way dependency is what keeps the pipeline stages decoupled.

The provisioner's OTHER seam is external — the scope-file format owned by the
harness (`autosploit_harness.contracts.scope.ScopeAllowlist`, validated by
`load_scope`). We import that directly rather than redefining it, so there is a
single source of truth for the format the handoff rides on (§3).
"""
