"""context — client-side transcript folding (docs/harness.md §5).

No server-side compaction from OpenRouter/OSS models, so the harness folds the
transcript itself, layered as the run lengthens:
  - trim:      truncate stale tool-result contents once they are on disk (the tool
               node already spilled the full output, addressable by call id). The
               transcript keeps a short head; `run_shell cat outputs/<id>.txt`
               recovers the rest.
  - summarize: near the model window, fold the older turns into one short recap the
               agent carries forward. Findings + attempt log live on disk (ledger),
               so a fold never loses a finding — only conversational scrollback.

DeepSeek V4 window is 1M tokens → these rarely fire (§5). The fold is applied to
the PROMPT COPY the agent node sends the model each turn, never to the durable
graph state or the ledger: the on-disk record stays whole, only what the model
re-reads shrinks. Under the trim threshold this is a cheap no-op — the common
case on a 1M window.

Pairing invariant: OpenAI-style transcripts require every tool result to follow
its assistant tool_call. Trim only shortens a ToolMessage's *content* (never drops
it), and summarize collapses a whole prefix at a boundary that leaves no orphan
tool result at the head of the kept tail — so the folded prompt stays well-formed.

Token counting is a cheap chars/4 heuristic (no tokenizer dependency); it only has
to be good enough to decide WHEN to fold, not to bill. `summarize_fn` is an
injection seam: pass an LLM summarizer to replace the deterministic recap when the
eval rig shows the pointer-recap loses too much (§5 "don't over-invest" until then).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    SystemMessage,
    ToolMessage,
)

# DeepSeek V4 context window (§5, §6). The fold thresholds are fractions of this;
# a Kimi/GLM swap re-checks the window (§5) by passing a different `window`.
DEFAULT_WINDOW = 1_000_000

# Past this fraction of the window, start trimming stale tool results.
TRIM_FRACTION = 0.5
# Still over this fraction after trimming → summarize the older turns.
SUMMARIZE_FRACTION = 0.75
# Always keep this many trailing messages verbatim (recent context the agent is
# actively reasoning over). Also the messages trim leaves untouched.
KEEP_RECENT = 8
# A trimmed (stale) tool result is capped to this many chars in the transcript.
STALE_TOOL_CAP = 1_000
# chars → tokens heuristic. Deliberately rough; only gates WHEN to fold.
CHARS_PER_TOKEN = 4

_TRIM_NOTE = (
    "\n…[stale tool result trimmed from context — full output on disk under "
    "outputs/; `run_shell` `cat` it if you need the rest]"
)


def _content_len(message: BaseMessage) -> int:
    """Char length of a message's textual content (list content is joined)."""
    content = message.content
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(str(part)) for part in content)
    return len(str(content))


def estimate_tokens(messages: Sequence[BaseMessage]) -> int:
    """Rough token estimate for the transcript (chars/4). Gates the fold only."""
    return sum(_content_len(m) for m in messages) // CHARS_PER_TOKEN


def _trim_stale(messages: list[BaseMessage], keep_recent: int) -> list[BaseMessage]:
    """Truncate long ToolMessage contents outside the recent tail.

    Never drops a message — only shortens content — so every tool result still
    follows its tool_call and the transcript stays well-formed. The full output is
    already on disk (tool node), so the head + pointer is enough.
    """
    cut = max(0, len(messages) - keep_recent)
    out: list[BaseMessage] = []
    for i, m in enumerate(messages):
        if (
            i < cut
            and isinstance(m, ToolMessage)
            and _content_len(m) > STALE_TOOL_CAP
            and not str(m.content).endswith(_TRIM_NOTE)
        ):
            head = str(m.content)[:STALE_TOOL_CAP]
            out.append(
                ToolMessage(
                    content=head + _TRIM_NOTE,
                    tool_call_id=m.tool_call_id,
                    status=getattr(m, "status", None) or "success",
                )
            )
        else:
            out.append(m)
    return out


def _safe_cut(messages: list[BaseMessage], keep_recent: int) -> int:
    """Index where the kept tail begins, advanced past any leading tool result.

    A ToolMessage must follow its assistant tool_call. If the tail were to start on
    a ToolMessage, its tool_call would be in the folded (dropped) prefix — an
    orphan. Advance the cut forward until the tail starts on a non-tool message.
    """
    cut = max(0, len(messages) - keep_recent)
    while cut < len(messages) and isinstance(messages[cut], ToolMessage):
        cut += 1
    return cut


def _default_recap(folded: list[BaseMessage]) -> str:
    """Deterministic pointer-recap for a folded prefix (no LLM call).

    Names the tools that were called and points at the durable stores. The ledger
    (findings + attempt log + outputs) is the real memory, so this only has to
    orient the agent, not reproduce the scrollback.
    """
    tool_calls: list[str] = []
    for m in folded:
        if isinstance(m, AIMessage):
            for call in m.tool_calls or []:
                name = call.get("name")
                if name:
                    tool_calls.append(name)
    if tool_calls:
        counts: dict[str, int] = {}
        for name in tool_calls:
            counts[name] = counts.get(name, 0) + 1
        called = ", ".join(f"{n}×{c}" for n, c in counts.items())
    else:
        called = "no tool calls"
    return (
        f"[context folded: {len(folded)} earlier message(s) summarized to save "
        f"window. Tools already run: {called}. Findings, the attempt log, and full "
        f"tool outputs are preserved on disk in the ledger (findings.jsonl, "
        f"attempts.jsonl, outputs/) — consult them rather than repeating work.]"
    )


def fold_transcript(
    messages: Sequence[BaseMessage],
    *,
    window: int = DEFAULT_WINDOW,
    keep_recent: int = KEEP_RECENT,
    summarize_fn: Callable[[list[BaseMessage]], str] | None = None,
    emitter=None,
) -> list[BaseMessage]:
    """Return a possibly-folded copy of the transcript for the model prompt (§5).

    Layered: under TRIM_FRACTION → returned unchanged (the no-op common case).
    Past it → trim stale tool results. Still past SUMMARIZE_FRACTION → collapse the
    older turns into one recap SystemMessage. The input list is never mutated; the
    durable state/ledger are untouched. When a fold happens and an emitter is given,
    a `phase` event (stage="fold") records it for the dashboard (§7).
    """
    msgs = list(messages)
    before = estimate_tokens(msgs)
    if before < int(window * TRIM_FRACTION):
        return msgs  # cheap path: nothing to fold on a generous window

    trimmed = _trim_stale(msgs, keep_recent)
    stage = "trim"
    after = estimate_tokens(trimmed)

    if after >= int(window * SUMMARIZE_FRACTION):
        cut = _safe_cut(trimmed, keep_recent)
        # Keep the first message (the objective) verbatim so the agent never loses
        # the goal; fold the middle prefix into a recap; keep the recent tail.
        head = trimmed[:1]
        prefix = trimmed[1:cut]
        tail = trimmed[cut:]
        if prefix:
            recap = (summarize_fn or _default_recap)(prefix)
            trimmed = [*head, SystemMessage(content=recap), *tail]
            stage = "summarize"
            after = estimate_tokens(trimmed)

    if emitter is not None and (stage != "trim" or after != before):
        emitter.emit(
            "phase",
            {
                "stage": "fold",
                "cause": stage,
                "before_tokens": before,
                "after_tokens": after,
                "messages_before": len(msgs),
                "messages_after": len(trimmed),
            },
        )
    return trimmed
