"use client";

// The live console: one merged, causal transcript of the whole engagement, so
// the operator watches the agent work instead of staring at an opaque wall.
// Three kinds of entry are interleaved in arrival order (lib/events buildTimeline):
//
//   phase    the agent's self-declared stage and, when present, its reasoning,
//            the "why I am doing this next" the model emits as it thinks.
//   tool     the real command or HTTP request it ran, shown inline, paired with
//            the structured result (ResultBlock) once it lands. Pending until then.
//   finding  the scored artifact, inline where it was recorded, as a beat.
//
// Auto-scrolls while pinned to the bottom, yields the moment the operator
// scrolls up to read history. No blinking markers: motion comes from new rows
// arriving, not from animation (design rules).

import { useEffect, useMemo, useRef } from "react";
import { cn, fmtTime } from "@/lib/format";
import {
  buildTimeline,
  type EngagementView,
  type PhaseData,
  type ToolExchange,
} from "@/lib/events";
import ResultBlock from "./ResultBlock";
import SeverityBadge from "./SeverityBadge";
import Markdown from "./Markdown";
import { ActivityIcon, WrenchIcon, TargetIcon, ClockIcon, CheckIcon, XIcon } from "./icons";

// The one-line command / request summary for a tool call, from its args.
function callLine(ex: ToolExchange): string {
  const a = ex.args ?? {};
  if (typeof a.cmd === "string") return a.cmd;
  const method = typeof a.method === "string" ? a.method : undefined;
  const url =
    (typeof a.url === "string" && a.url) ||
    (typeof a.path === "string" && a.path) ||
    (typeof a.host === "string" && a.host) ||
    "";
  if (method || url) return `${method ? method + " " : ""}${url}`.trim();
  const keys = Object.keys(a);
  return keys.length ? keys.map((k) => `${k}=${String(a[k])}`).join(" ") : "";
}

function Gutter({
  icon: Icon,
  danger,
}: {
  icon: (p: { size?: number; className?: string }) => React.ReactElement;
  danger?: boolean;
}) {
  return (
    <span
      className={cn(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
        danger
          ? "border-accent-line text-accent-bright"
          : "border-white/10 text-faint",
      )}
    >
      <Icon size={13} />
    </span>
  );
}

function PhaseEntry({ p }: { p: PhaseData & { ts: string } }) {
  const bare = !p.reasoning && !p.summary;
  return (
    <li className="flex gap-3 border-t border-white/5 py-3 first:border-t-0">
      <Gutter icon={ActivityIcon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium capitalize text-text">
            {p.stage}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">
            {fmtTime(p.ts)}
          </span>
        </div>
        {p.summary && (
          <Markdown className="mt-1 text-sm leading-relaxed text-muted">
            {p.summary}
          </Markdown>
        )}
        {p.reasoning && (
          <p className="mt-1 border-l border-accent-line pl-3 text-sm italic leading-relaxed text-muted">
            {p.reasoning}
          </p>
        )}
        {bare && (
          <span className="text-xs text-faint">Entered {p.stage}.</span>
        )}
      </div>
    </li>
  );
}

function ToolEntry({ ex }: { ex: ToolExchange }) {
  const pending = !ex.result;
  const errored = ex.result?.is_error;
  const line = callLine(ex);
  return (
    <li className="flex gap-3 border-t border-white/5 py-3 first:border-t-0">
      <Gutter icon={WrenchIcon} danger={errored} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono text-xs text-faint">{ex.name}</span>
            {line && (
              <span className="ml-2 font-mono text-sm text-text">{line}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
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
        </div>
        {ex.result && <ResultBlock result={ex.result} />}
      </div>
    </li>
  );
}

function FindingEntry({
  f,
}: {
  f: { id: string; title: string; severity: string; ts: string };
}) {
  return (
    <li className="flex gap-3 border-t border-white/5 py-3 first:border-t-0">
      <Gutter icon={TargetIcon} danger />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <SeverityBadge severity={f.severity} />
        <span className="min-w-0 flex-1 truncate text-sm text-text">
          Recorded {f.title}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint">{f.id}</span>
      </div>
    </li>
  );
}

export default function ActivityStream({ view }: { view: EngagementView }) {
  const timeline = useMemo(() => buildTimeline(view), [view]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = gap < 40;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  if (timeline.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-faint">
        Waiting for the agent to start.
      </p>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="max-h-[36rem] overflow-y-auto px-4"
    >
      <ul className="flex flex-col">
        {timeline.map((e) => {
          if (e.kind === "phase")
            return <PhaseEntry key={`p-${e.ord}`} p={e.data as PhaseData & { ts: string }} />;
          if (e.kind === "tool")
            return <ToolEntry key={`t-${e.ord}`} ex={e.exchange} />;
          return <FindingEntry key={`f-${e.ord}`} f={e.data} />;
        })}
      </ul>
    </div>
  );
}
