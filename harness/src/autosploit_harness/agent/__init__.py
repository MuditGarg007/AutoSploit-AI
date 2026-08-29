"""agent — the LangGraph loop slice (docs/harness.md §2).

A state graph: the agent node takes an LLM turn and emits tool call(s); a
conditional edge routes to the interceptor node before any tool runs. This slice
owns the graph topology and the agent's reasoning turn — NOT the gate (that's
interceptor/) and NOT the model provider (that's gateway/). It receives an
already-bound model and an already-built interceptor node.
"""
