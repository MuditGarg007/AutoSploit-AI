// Budget meter. The scope/budget interceptor halts a run fail-closed when a cap
// is hit (overview §7), so the dashboard shows how close each metric is to its
// cap. Bars fill burgundy only as they approach the cap, quiet until it matters.

import { cn, fmtUsd, fmtCompact, fmtInt } from "@/lib/format";
import type { CostData } from "@/lib/events";

function Bar({ frac }: { frac: number }) {
  const pct = Math.min(100, Math.max(0, frac * 100));
  const near = frac >= 0.8;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/5">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          near ? "bg-accent-bright" : "bg-white/25",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  cap,
  frac,
}: {
  label: string;
  value: string;
  cap?: string;
  frac?: number;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-faint">{label}</span>
        <span className="font-mono text-sm text-text">
          {value}
          {cap && <span className="text-faint"> / {cap}</span>}
        </span>
      </div>
      {frac !== undefined && <Bar frac={frac} />}
    </div>
  );
}

export default function CostMeter({ cost }: { cost?: CostData }) {
  const usd = cost?.usd ?? 0;
  const tokens = cost?.tokens ?? 0;
  const calls = cost?.tool_calls ?? 0;
  const caps = cost?.caps ?? {};

  return (
    <div className="flex flex-col gap-5">
      <Metric
        label="Spend"
        value={fmtUsd(usd)}
        cap={caps.usd !== undefined ? fmtUsd(caps.usd) : undefined}
        frac={caps.usd ? usd / caps.usd : undefined}
      />
      <Metric
        label="Tokens"
        value={fmtCompact(tokens)}
        cap={caps.tokens !== undefined ? fmtCompact(caps.tokens) : undefined}
        frac={caps.tokens ? tokens / caps.tokens : undefined}
      />
      <Metric
        label="Tool calls"
        value={fmtInt(calls)}
        cap={caps.tool_calls !== undefined ? fmtInt(caps.tool_calls) : undefined}
        frac={caps.tool_calls ? calls / caps.tool_calls : undefined}
      />
    </div>
  );
}
