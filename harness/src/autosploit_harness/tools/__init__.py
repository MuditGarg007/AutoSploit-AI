"""tools — typed adapter slice (docs/harness.md §4, §7).

The only path to running anything: even run_shell is a typed adapter, not a raw
exec the model reaches directly (§7 — no ad-hoc shell escapes). Each tool wraps a
subprocess/HTTP call, returns a structured result (contracts/results.py), and
emits a tool event. Start with the four in §4 (run_shell, http_request,
note_finding, engagement_complete); add typed tools (port_scan, sqli_probe) only
if the loop measurably bottlenecks on shell for them — don't pre-build.
"""
