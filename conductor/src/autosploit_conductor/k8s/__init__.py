"""Phase B — the conductor as a Kubernetes controller (docs/orchestration.md §6).

Roadmap milestone M6: replace the Phase-A subprocess conductor with a real
`kubernetes` client. One Namespace per engagement (`engagement-<id>`), attacker
+ target Pods under the gVisor RuntimeClass, the target exposed via a Service,
watched to completion, torn down by deleting the namespace.

`manifests.py` is the pure layer (M6 step 1): it builds the k8s object dicts and
touches no API, mirroring the way `context.py`/`config_gen.py` are pure and land
with tests before anything spawns a subprocess. The API-driving layers stack on
top of it.
"""
