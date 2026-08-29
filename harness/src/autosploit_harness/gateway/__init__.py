"""gateway — model provider isolation slice (docs/harness.md §6).

A thin wrapper around OpenRouter's OpenAI-compatible endpoint so the rest of the
harness never names a provider. Swapping DeepSeek → Kimi → GLM is a config line,
not a code change. Kept separate from agent/ on purpose: the agent slice only
ever sees an already-bound model; provider concerns (base_url, key, fallback
list, usage/cost) stay here.
"""
