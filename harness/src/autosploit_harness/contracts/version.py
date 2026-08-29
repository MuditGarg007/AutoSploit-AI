"""Contract version — the compat handle for the frozen seams (docs/harness.md §9 step 5).

The one number two languages agree on. The Python harness stamps it into the run
manifest + the exported contract descriptor; the TS control plane / provisioner
read it to assert they speak the same seam shape before plugging in. Bump it when
a seam changes shape (scope-file format, event schema, driver/report signature):

  MAJOR — a breaking reshape (field removed/renamed/retyped). Consumers must update.
  MINOR — an additive field (new optional key, new event type). Old consumers still parse.
  PATCH — doc/description-only change, no shape movement.

Freezing means: this string only moves on purpose, and the drift test
(tests/test_contracts.py) fails the build if the shapes move without it.
"""

from __future__ import annotations

CONTRACT_VERSION = "1.0.0"
