// Key-value rail panel, the Neon "Branch / Project" metadata vibe. A small
// title, then label-left / value-right rows. Labels are quiet sentence case;
// values default to mono since they are IDs, targets, and metrics (design
// rules). `accent` flips a value to burgundy for the rare row that must carry
// weight. Use MetaPanel to wrap a set of MetaRow children.

import { cn } from "@/lib/format";

export function MetaRow({
  label,
  value,
  accent,
  plain,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
  plain?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-sm",
          !plain && "font-mono",
          accent ? "text-accent-bright" : "text-muted",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export default function MetaPanel({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-md border border-white/10 bg-surface px-4 py-3.5",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 pb-2">
        <h3 className="text-sm font-semibold tracking-tight text-text">
          {title}
        </h3>
        {aside}
      </header>
      <div className="flex flex-col divide-y divide-white/5">{children}</div>
    </section>
  );
}
