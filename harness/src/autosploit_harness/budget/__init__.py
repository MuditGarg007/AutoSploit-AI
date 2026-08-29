"""budget — shared cap state slice (docs/harness.md §6.2, §3).

Its own slice because two slices touch it: gateway/ MEASURES (writes token/USD/
tool-call counts from OpenRouter usage) and interceptor/ ENFORCES (reads them,
halts the run when a cap is crossed). Shared state gets its own home rather than
being buried in either. Same budget primitive the platform meters on later
(overview.md §8) — built in, not bolted on.
"""
