"""state — BudgetState + cap checks (docs/harness.md §6.2, §3).

Holds running totals (tokens, USD, tool-call count) and the configured caps.
Exposes: record_usage(...) for the gateway meter to add a turn's spend, and
over_cap() for the interceptor to test before each tool call. Flash ~$0.07/$0.18
per MTok, Pro ~$0.28/$0.56 — an order under Claude, so caps can be generous.
Crossing a cap → interceptor halts the run (partial report), not just blocks the
call (§3).

Skeleton (§9 step 1): the tool-call count cap is the live guard (the cheap
runaway-loop guard, §6.2). Token/USD caps + record_usage are wired here too, but
they only bite once the gateway meter feeds real usage (step 3). A cap of 0 means
"unlimited" — an unset cap never halts.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class BudgetState:
    """Mutable per-run budget: caps (immutable intent) + running totals.

    Shared handle: gateway/ MEASURES (record_usage), interceptor/ ENFORCES
    (over_cap). A cap of 0 = unlimited for that dimension.
    """

    # Caps — 0 means unlimited.
    max_tokens: int = 0
    max_usd: float = 0.0
    max_tool_calls: int = 0

    # Running totals.
    tokens: int = 0
    usd: float = 0.0
    tool_calls: int = 0

    def record_usage(self, prompt_tokens: int, completion_tokens: int, usd: float) -> None:
        """Gateway meter adds a turn's spend (§6.2). Token/USD only — tool-call
        count is recorded per call by record_tool_call()."""
        self.tokens += prompt_tokens + completion_tokens
        self.usd += usd

    def record_tool_call(self, n: int = 1) -> None:
        """Interceptor counts allowed tool calls. The cheap runaway-loop guard."""
        self.tool_calls += n

    def over_cap(self) -> str | None:
        """Return the reason string of the first crossed cap, else None.

        Deterministic, no LLM. The interceptor calls this before each tool step;
        a non-None result halts the run (partial report), it does not just block
        the one call (§3).
        """
        if self.max_tool_calls and self.tool_calls >= self.max_tool_calls:
            return f"tool-call cap reached ({self.tool_calls}/{self.max_tool_calls})"
        if self.max_tokens and self.tokens >= self.max_tokens:
            return f"token cap reached ({self.tokens}/{self.max_tokens})"
        if self.max_usd and self.usd >= self.max_usd:
            return f"USD cap reached (${self.usd:.4f}/${self.max_usd:.4f})"
        return None

    def totals(self) -> dict:
        """Snapshot for cost/halt events + the report."""
        return {
            "tokens": self.tokens,
            "usd": round(self.usd, 6),
            "tool_calls": self.tool_calls,
            "caps": {
                "max_tokens": self.max_tokens,
                "max_usd": self.max_usd,
                "max_tool_calls": self.max_tool_calls,
            },
        }
