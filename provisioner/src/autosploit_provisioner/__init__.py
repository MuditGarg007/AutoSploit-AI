"""autosploit_provisioner — the target provisioner (docs/provisioner.md).

Turns a repo reference into a running target + an immutable scope file the harness
consumes, then tears it down (§1). It handles untrusted repo code ONLY and never
holds secrets — the trust boundary that keeps the model API key out of reach of
code we did not write (§2, orchestration.md §2).

Phase A is plain local Docker: shallow-clone / resolve a ref, build from a
Dockerfile, run with `-P`, discover the published ports, emit a `scope.yaml` in
the FROZEN format the harness already reads (§3), record a `provision.json`, and
always tear the container down. Kubernetes / Kaniko / NetworkPolicy are Phase B
(orchestration.md §9).

Package layout is vertical-slice, mirroring the harness: each subpackage owns one
box from §4 (source, build, discovery, emit, teardown). Slices only touch each
other through the frozen shapes in `contracts/` — the one-way dependency that
stops slices reaching into each other. The single external seam is the harness's
`load_scope`, which the emit slice calls to self-validate the scope it writes (§3).
"""
