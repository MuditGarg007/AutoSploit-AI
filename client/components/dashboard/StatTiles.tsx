// KPI tiles, the Neon-style overview strip. Each tile is a surface card with a
// small mono caption and one metric in mono. `accent` flips the value to
// burgundy for the one state that must carry weight (halted / failed). Values
// are plain strings so callers format with the shared helpers.

import { cn } from "@/lib/format";
import type { IconProps } from "./icons";

export type Stat = {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  icon?: (p: IconProps) => React.ReactElement;
};

function Tile({ stat }: { stat: Stat }) {
  const Icon = stat.icon;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-surface px-4 py-3.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
        {Icon && <Icon size={13} className="text-faint" />}
        {stat.label}
      </span>
      <span
        className={cn(
          "font-mono text-xl tabular-nums",
          stat.accent ? "text-accent-bright" : "text-text",
        )}
      >
        {stat.value}
      </span>
      {stat.hint && (
        <span className="text-xs text-faint">{stat.hint}</span>
      )}
    </div>
  );
}

export default function StatTiles({
  stats,
  className,
}: {
  stats: Stat[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5",
        className,
      )}
    >
      {stats.map((s) => (
        <Tile key={s.label} stat={s} />
      ))}
    </div>
  );
}
