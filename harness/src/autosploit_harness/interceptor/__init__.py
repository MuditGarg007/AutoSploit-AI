"""interceptor — the load-bearing gate slice (docs/harness.md §3, §7).

Deterministic, no LLM, fail-closed. Runs before EVERY tool execution — expressed
as graph topology (a node), not as a convention inside the agent's reasoning.
This is the §7 platform guarantee made concrete. Isolated in its own slice, with
its own tests, and written fail-closed: any error (malformed call, parse
failure, missing scope field) → deny. Never default-allow.
"""
