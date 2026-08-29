"""client — the bound model (docs/harness.md §6).

langchain-openai ChatOpenAI pointed at base_url="https://openrouter.ai/api/v1"
with the OpenRouter key. LangGraph binds tools and drives the loop through the
standard OpenAI function-calling interface — no Anthropic SDK. Defaults (§6):
  - model:      deepseek/deepseek-v4-flash (1M ctx, ~393K max output).
  - reasoning:  OpenRouter `reasoning` effort (high / xhigh); start off/high on
                Flash, raise or move to Pro if the exploit loop needs depth.
  - max_tokens: generous + stream — a tight cap truncates mid-exploit.
Returns reasoning content so nodes can surface it to the event stream (§6).

Step 3 (§9 gateway hardening): three OpenRouter-native features ride in via
`extra_body`, which passes fields straight to the API without the langchain
"unknown model_kwargs" warning that `model_kwargs` produced:
  - reasoning  → {"reasoning": {"effort": ...}}          (was model_kwargs; §6)
  - fallbacks  → {"models": [primary, *fallbacks]}        availability fallback (§6.1.4)
  - usage cost → {"usage": {"include": true}}             so responses carry USD cost (§6.2)

Streaming is OFF on purpose: the agent loop drives the model with .invoke(), which
aggregates the whole message regardless, so streaming buys nothing here — and
langchain's stream-merge drops OpenRouter's per-response `cost` (and doubles the
finish_reason). Non-streaming lands the full usage block, cost included, in
response_metadata["token_usage"] where the meter reads it (§6.2). max_tokens still
bounds the output either way, so the "stream so a tight cap can't truncate" note
(§6) is satisfied by the generous cap, not by client-side streaming.
"""

from __future__ import annotations

import os

from autosploit_harness.gateway.fallback import model_list
from autosploit_harness.tools.registry import tool_specs

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def build_extra_body(
    model_id: str,
    *,
    reasoning: str | None = None,
    fallbacks: tuple[str, ...] = (),
) -> dict:
    """Assemble the OpenRouter-native extra_body (§6, §6.1.4, §6.2).

    Always asks for usage cost so the meter has real USD to read (§6.2). Adds the
    reasoning effort and the availability fallback list only when configured, so a
    bare run sends the minimal body.
    """
    extra: dict = {"usage": {"include": True}}
    if reasoning and reasoning != "off":
        extra["reasoning"] = {"effort": reasoning}
    if fallbacks:
        extra["models"] = model_list(model_id, fallbacks)
    return extra


def build_model(
    model_id: str,
    *,
    reasoning: str | None = None,
    max_tokens: int | None = None,
    fallbacks: tuple[str, ...] = (),
    api_key: str | None = None,
):
    """Return a tool-bound ChatOpenAI over OpenRouter, ready for the agent node.

    Raises if no API key is available — fail early, before the graph starts,
    rather than mid-exploit.
    """
    from langchain_openai import (
        ChatOpenAI,  # local import: keeps fake-model tests import-light
    )

    key = api_key or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Export it, or pass a model directly "
            "(the smoke test injects a fake model instead)."
        )

    llm = ChatOpenAI(
        model=model_id,
        base_url=OPENROUTER_BASE_URL,
        api_key=key,
        max_tokens=max_tokens,
        streaming=False,  # see module docstring: lands OpenRouter cost for the meter (§6.2)
        extra_body=build_extra_body(
            model_id, reasoning=reasoning, fallbacks=fallbacks
        ),
    )
    return llm.bind_tools(tool_specs())
