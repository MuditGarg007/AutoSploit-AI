"use client";

// Live tool-call log. Every subprocess the engine runs goes through a typed tool
// adapter and a scope/budget interceptor (overview §7); this is that stream,
// call paired with result. Pending calls show until their result lands; errored
// results carry the accent. Args expand on click. Auto-scrolls while pinned to
// the bottom, but yields if the user scrolls up to read history.

import { useEffect, useRef, useState } from "react";
import { cn, fmtTime } from "@/lib/format";
import type { ToolExchange } from "@/lib/events";
import { ClockIcon, CheckIcon, XIcon } from "./icons";

function ArgsBlock({ args }: { args: Record<string, unknown> }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md border border-white/10 bg-black p-3 font-mono text-[11px] leading-relaxed text-muted">
      {JSON.stringify(args, null, 2)}
    </pre>
  );
}

function Row({ t }: { t: ToolExchange }) {
  const [open, setOpen] = useState(false);
  const pending = !t.result;
  const errored = t.result?.is_error;
  const hasArgs = t.args && Object.keys(t.args).length > 0;

  return (
    <li className="border-t border-white/5 py-2 first:border-t-0">
      <button
        type="button"
        onClick={() => hasArgs && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-baseline gap-3 text-left",
          hasArgs && "cursor-pointer",
        )}
      >
        <span className="font-mono text-[10px] text-faint tabular-nums">
          {fmtTime(t.ts)}
        </span>
        <span className="font-mono text-sm text-text">{t.name}</span>
        <span className="ml-auto text-xs font-medium">
          {pending ? (
            <span className="flex items-center gap-1.5 text-faint">
              <ClockIcon size={13} />
              Running
            </span>
          ) : errored ? (
            <span className="flex items-center gap-1.5 text-accent-bright">
              <XIcon size={13} />
              Error
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-faint">
              <CheckIcon size={13} />
              Done
            </span>
          )}
        </span>
      </button>

      {errored && t.result?.error && (
        <p className="mt-1 pl-[3.25rem] font-mono text-[11px] text-accent">
          {t.result.error}
          {t.result.truncated && (
            <span className="text-faint"> (truncated)</span>
          )}
        </p>
      )}

      {open && hasArgs && (
        <div className="pl-[3.25rem]">
          <ArgsBlock args={t.args!} />
        </div>
      )}
    </li>
  );
}

export default function ToolCallFeed({ tools }: { tools: ToolExchange[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Track whether the user is pinned to the bottom; only auto-scroll if so.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = gap < 40;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [tools]);

  if (tools.length === 0) {
    return <p className="text-sm text-faint">No tool calls yet.</p>;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="max-h-[28rem] overflow-y-auto pr-1"
    >
      <ul className="flex flex-col">
        {tools.map((t) => (
          <Row key={t.key} t={t} />
        ))}
      </ul>
    </div>
  );
}
