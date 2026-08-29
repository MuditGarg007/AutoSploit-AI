"""autosploit_harness — the attack engine (docs/harness.md).

The agent loop that runs inside the attacker sandbox: LLM decides the next
action, a deterministic interceptor gates every tool call (scope + budget,
fail-closed), typed tools execute, an on-disk ledger records everything, and a
JSONL event stream mirrors it for the dashboard.

Built standalone first (one machine, one local vulnerable target, no auth /
queue / microVM / control plane). See docs/harness.md §1 for the six parts and
§9 for the build order.

Package layout is vertical-slice: each subpackage owns one box from §1
(driver, agent, interceptor, tools, gateway, budget, ledger, events). Slices
only touch each other through the frozen shapes in `contracts/` — the seams the
TS control plane plugs into later (§9).
"""
