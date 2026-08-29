"""ledger — on-disk memory slice (docs/harness.md §5).

Survives the run and is the report source. Three stores: findings (the scored
artifact), attempt log (what was tried → stops re-running failed probes, feeds
"what haven't I tried"), and raw tool outputs (addressable by id, truncated in-
context / full on disk). Also owns client-side context management (trim /
summarize) — no server-side compaction from OSS models, so the harness does it.
Because findings live here on disk, summarization never drops one.
"""
