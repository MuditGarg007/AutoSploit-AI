"""Phase B provision seam — where the in-cluster target build plugs in (roadmap M8).

`run_k8s` takes a `provision` callable that deploys the target and returns the run
files. The real implementation is the in-cluster **Kaniko** build of the user repo
(roadmap M8) plus the target Pod/Service deploy and the Service-DNS scope emit
(M6a, contract 1.1.0). None of that is built yet.

Until then `phaseb_provision` raises, which `run_k8s` records as a clean
`failed(provision)` (the target never came up) rather than a crash — so the `--k8s`
CLI path is wired end to end and honestly reports "not built yet" instead of
pretending. Swap this for the real provisioner call at M8.
"""

from __future__ import annotations

from autosploit_conductor.context import EngagementContext
from autosploit_conductor.k8s.run import K8sProvision


def phaseb_provision(repo_ref: str, ctx: EngagementContext) -> K8sProvision:
    """Not built yet — the in-cluster target build/deploy is roadmap M8."""
    raise NotImplementedError(
        "Phase B in-cluster provisioner (Kaniko build + target deploy + "
        "Service-DNS scope, roadmap M8) is not built yet"
    )
