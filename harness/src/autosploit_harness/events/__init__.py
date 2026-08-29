"""events — emitter slice (docs/harness.md §7).

Writes the run's event stream. Standalone = JSONL to stdout/file, faking the SSE
gateway; production = the real SSE gateway. Same schema either way
(contracts/events.py), which is the frozen seam the TS control plane later
consumes unchanged. This slice is emission only — the schema shape lives in
contracts/.
"""
