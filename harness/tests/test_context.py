"""Context-folding tests (docs/harness.md §5) — the client-side window management.

Covers the layered fold: no-op under threshold (the common 1M-window case), trim
of stale tool results past it, summarize of older turns near the window, and the
pairing invariant (no orphan tool result at the head of the kept tail). A tiny
`window` forces the folds that a real 1M window rarely triggers.

Sizing note: trim only shrinks tool results OVER STALE_TOOL_CAP, so the trim test
uses fat (over-cap) tool contents and the summarize tests use small (under-cap)
ones — that way summarize fires on volume without trim first shrinking it away.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from autosploit_harness.events.emitter import JsonlEmitter
from autosploit_harness.ledger import context


def _tool_call(name, cid, **args):
    return {"name": name, "args": args, "id": cid}


def _big_turns(n, content):
    """n assistant tool_call + tool result pairs, each result carrying `content`."""
    msgs = []
    for i in range(n):
        cid = f"c{i}"
        msgs.append(AIMessage(content="", tool_calls=[_tool_call("run_shell", cid, cmd=f"c{i}")]))
        msgs.append(ToolMessage(content=content, tool_call_id=cid))
    return msgs


def test_no_fold_under_threshold():
    """A short transcript on a generous window is returned unchanged (identity)."""
    msgs = [HumanMessage(content="objective"), AIMessage(content="ok")]
    out = context.fold_transcript(msgs, window=context.DEFAULT_WINDOW)
    assert out == msgs


def test_estimate_tokens_counts_chars_over_four():
    msgs = [HumanMessage(content="a" * 4000)]
    assert context.estimate_tokens(msgs) == 1000


def test_trim_shortens_stale_tool_results_only():
    """Past the trim threshold, old (over-cap) tool results are capped; recent stay."""
    big = "X" * 5000  # over STALE_TOOL_CAP → trim shrinks it
    msgs = [HumanMessage(content="obj"), *_big_turns(12, big)]

    # window == estimate → trim threshold (0.5·window) is crossed; the shrunk
    # transcript stays under the summarize threshold, so only trim fires.
    window = context.estimate_tokens(msgs)
    out = context.fold_transcript(msgs, window=window, keep_recent=4)

    assert len(out) == len(msgs)  # trim never drops a message
    assert isinstance(out[2], ToolMessage)  # first tool result is stale → trimmed
    assert out[2].content.endswith(context._TRIM_NOTE)
    assert len(out[2].content) <= context.STALE_TOOL_CAP + len(context._TRIM_NOTE)
    assert out[-1].content == big  # most-recent tool result stays whole


def test_summarize_collapses_prefix_and_keeps_objective_and_tail():
    """Near the window, older turns fold into one recap; objective + tail survive."""
    small = "Y" * 900  # under STALE_TOOL_CAP → trim leaves it; volume drives summarize
    msgs = [HumanMessage(content="OBJECTIVE-MARKER"), *_big_turns(20, small)]
    msgs[1] = AIMessage(content="", tool_calls=[_tool_call("http_request", "c0", url="u0")])

    window = int(context.estimate_tokens(msgs) * 0.8)  # 0.75·window < estimate → summarize
    out = context.fold_transcript(msgs, window=window, keep_recent=6)

    assert out[0].content == "OBJECTIVE-MARKER"  # objective preserved
    assert isinstance(out[1], SystemMessage)  # the recap
    assert "context folded" in out[1].content
    assert "run_shell" in out[1].content  # names tools already run
    assert len(out) < len(msgs)  # prefix collapsed


def test_summarize_leaves_no_orphan_tool_result_at_tail_head():
    """The kept tail must not START on a tool result (its tool_call would be gone)."""
    small = "Z" * 900
    msgs = [HumanMessage(content="obj"), *_big_turns(20, small)]

    window = int(context.estimate_tokens(msgs) * 0.8)
    out = context.fold_transcript(msgs, window=window, keep_recent=5)

    # out = [objective, recap, ...tail]; first tail message is not a ToolMessage.
    assert isinstance(out[1], SystemMessage)
    assert not isinstance(out[2], ToolMessage)


def test_fold_emits_phase_event_with_stage_fold():
    """A real fold records a `phase` event (stage=fold) for the dashboard (§7)."""
    big = "Q" * 5000
    msgs = [HumanMessage(content="obj"), *_big_turns(12, big)]

    emitter = JsonlEmitter(path=None, stdout=False)
    window = context.estimate_tokens(msgs)
    context.fold_transcript(msgs, window=window, keep_recent=4, emitter=emitter)

    fold_events = [e for e in emitter.events if e["data"].get("stage") == "fold"]
    assert fold_events
    assert fold_events[0]["data"]["cause"] in {"trim", "summarize"}


def test_custom_summarize_fn_is_used():
    """The summarize_fn seam replaces the deterministic recap when supplied."""
    small = "W" * 900
    msgs = [HumanMessage(content="obj"), *_big_turns(20, small)]

    window = int(context.estimate_tokens(msgs) * 0.8)
    out = context.fold_transcript(
        msgs, window=window, keep_recent=6, summarize_fn=lambda _p: "CUSTOM-RECAP"
    )
    assert any(isinstance(m, SystemMessage) and m.content == "CUSTOM-RECAP" for m in out)
