# AutoSploit-AI — working notes for Claude

## Known issues

### Provisioner `build/` package is missing (breaks 3 conductor tests)

`provisioner/src/autosploit_provisioner/teardown/teardown.py` imports
`ENGAGEMENT_LABEL` from `autosploit_provisioner.build.booter`, but the whole
`build/` package does not exist on disk (`provisioner/src/autosploit_provisioner/`
has no `build/` directory). Importing the provisioner's `teardown` therefore
raises `ModuleNotFoundError: No module named 'autosploit_provisioner.build'`.

Because `conductor/src/autosploit_conductor/teardown.py` imports the provisioner
teardown directly, this breaks **collection** of three conductor test files:

- `conductor/tests/test_run.py`
- `conductor/tests/test_scaffold.py`
- `conductor/tests/test_teardown.py`

The rest of the conductor suite (including the Phase B / M6 `k8s/` layer) is
unaffected and passes. This is a pre-existing provisioner Phase-A gap, not caused
by the M6 work. Fix belongs in the provisioner: restore the `build.booter` module
(defining `ENGAGEMENT_LABEL` and `boot`) or move `ENGAGEMENT_LABEL` to a module
that still exists. Discovered 2026-09-23 during M6.

Mitigation already applied so it doesn't spread: `cli.py` imports the Phase-A
`run` **lazily** (inside the non-`--k8s` branch), so importing the conductor CLI
and running the Phase-B (`--k8s`) path no longer depend on the provisioner
teardown. Only the three test files above, which import `teardown`/`run`
directly, still fail collection until the provisioner gap is fixed.
