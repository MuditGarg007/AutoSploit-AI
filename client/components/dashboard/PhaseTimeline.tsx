// Ordered phase history. The engine's new architecture is adaptive, not a fixed
// pipeline (overview §7), so this renders whatever stages the stream reports
// rather than a hardcoded pipeline. Current stage carries the accent; past
// stages are quiet. No animated markers.

import { cn, fmtTime } from "@/lib/format";
import type { PhaseData } from "@/lib/events";

export default function PhaseTimeline({
  phases,
  currentStage,
}: {
  phases: (PhaseData & { ts: string })[];
  currentStage?: string;
}) {
  if (phases.length === 0) {
    return <p className="text-sm text-faint">Awaiting first phase.</p>;
  }
  return (
    <ol className="flex flex-col">
      {phases.map((p, i) => {
        const current = i === phases.length - 1 && p.stage === currentStage;
        const last = i === phases.length - 1;
        return (
          <li
            key={`${p.stage}-${p.ts}-${i}`}
            className={cn(
              "relative pl-5",
              !last && "pb-5",
            )}
          >
            {/* rail line connecting the steps */}
            {!last && (
              <span className="absolute left-[3px] top-2 h-full w-px bg-white/10" />
            )}
            {/* step node: a small ring, filled burgundy for the current stage */}
            <span
              className={cn(
                "absolute left-0 top-1 h-[7px] w-[7px] rounded-full border",
                current
                  ? "border-accent-bright bg-accent-bright"
                  : "border-white/25 bg-canvas",
              )}
            />
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={cn(
                  "text-sm font-medium capitalize",
                  current ? "text-text" : "text-muted",
                )}
              >
                {p.stage}
              </span>
              <span className="font-mono text-[10px] text-faint tabular-nums">
                {fmtTime(p.ts)}
              </span>
            </div>
            {p.summary && (
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {p.summary}
              </p>
            )}
            {p.reasoning && (
              <p className="mt-1 text-xs leading-relaxed text-faint">
                {p.reasoning}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
