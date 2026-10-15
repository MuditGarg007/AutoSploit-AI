// Renders one tool_result by its structured shape, so the operator sees what the
// agent actually got back, not a bare "done". The harness spreads the matching
// result shape into the event (ShellResult / HttpResult / FindingId), truncated
// to 16k for the stream; this reads those fields:
//
//   run_shell     exit code, stdout, stderr (terminal block)
//   http_request  method, url, status, headers (collapsible), body
//   error         the error message in the accent
//
// Terminal output sits in a flat-black block (the one place black is used on a
// product surface, matching the repro / args blocks) so a scan reads like a
// console. No colored severity flood: the accent marks only a failing exit code,
// a 4xx/5xx status, or an errored call.

import { useState } from "react";
import { cn } from "@/lib/format";
import type { ToolResultData } from "@/lib/events";
import { ChevronRightIcon } from "./icons";

function Chip({
  text,
  danger,
  ok,
}: {
  text: string;
  danger?: boolean;
  ok?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider",
        danger
          ? "border-accent-line text-accent-bright"
          : ok
            ? "border-ok-line text-ok"
            : "border-white/10 text-faint",
      )}
    >
      {text}
    </span>
  );
}

function Terminal({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-white/10 bg-black p-3 font-mono text-[11px] leading-relaxed text-muted">
      {children}
    </pre>
  );
}

export default function ResultBlock({ result }: { result: ToolResultData }) {
  const [showHeaders, setShowHeaders] = useState(false);

  // Transport / adapter error: the call never produced a structured result.
  if (result.is_error) {
    return (
      <div className="mt-2">
        <p className="font-mono text-[11px] leading-relaxed text-accent">
          {result.error ?? "errored"}
        </p>
        {result.truncated && (
          <span className="mt-1 block text-[10px] text-faint">
            output truncated
          </span>
        )}
      </div>
    );
  }

  // ShellResult
  if (result.cmd !== undefined || result.exit_code !== undefined) {
    const failed = (result.exit_code ?? 0) !== 0;
    const body = (result.stdout ?? "") + (result.stderr ? `\n${result.stderr}` : "");
    return (
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip text={`exit ${result.exit_code ?? "?"}`} danger={failed} />
          {result.timed_out && <Chip text="timed out" danger />}
          {result.truncated && <Chip text="truncated" />}
        </div>
        {body.trim() && <Terminal>{body}</Terminal>}
      </div>
    );
  }

  // HttpResult
  if (result.status !== undefined || result.url !== undefined) {
    const bad = (result.status ?? 0) >= 400;
    const good = (result.status ?? 0) >= 200 && (result.status ?? 0) < 300;
    const headerText = result.headers
      ? Object.entries(result.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "";
    return (
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-2">
          {result.status !== undefined && (
            <Chip text={String(result.status)} danger={bad} ok={good} />
          )}
          {result.truncated && <Chip text="truncated" />}
          {headerText && (
            <button
              type="button"
              onClick={() => setShowHeaders((o) => !o)}
              className="inline-flex items-center gap-1 text-[10px] text-faint transition-colors hover:text-muted"
            >
              <ChevronRightIcon
                size={12}
                className={cn("transition-transform", showHeaders && "rotate-90")}
              />
              headers
            </button>
          )}
        </div>
        {showHeaders && headerText && <Terminal>{headerText}</Terminal>}
        {result.body?.trim() && <Terminal>{result.body}</Terminal>}
      </div>
    );
  }

  // FindingId / CompleteResult (summary) or anything else with no body to show.
  if (result.summary) {
    return (
      <p className="mt-2 text-xs leading-relaxed text-muted">{result.summary}</p>
    );
  }

  return null;
}
