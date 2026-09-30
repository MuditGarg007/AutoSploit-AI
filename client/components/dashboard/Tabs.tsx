"use client";

// Section tabs for a dashboard view. A single hairline-bordered row of triggers;
// the active one carries a burgundy underline (the one place the accent earns
// its weight on this view) and white text, the rest stay quiet. An optional
// count rides after a label as a small mono figure. No pills, no animated
// markers (design rules). The caller owns the active id and the panel below.

import { cn } from "@/lib/format";

export type TabDef = {
  id: string;
  label: string;
  count?: number;
};

export default function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Engagement sections"
      className={cn(
        "flex items-center gap-6 overflow-x-auto border-b border-white/10",
        className,
      )}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 pb-3 pt-1 text-sm font-medium transition-colors",
              on
                ? "border-accent text-text"
                : "border-transparent text-faint hover:text-muted",
            )}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span
                className={cn(
                  "font-mono text-xs tabular-nums",
                  on ? "text-muted" : "text-faint",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
