// Finding severity as a small mono label. Burgundy is a scalpel: only critical
// and high carry the accent. Medium/low/info stay in the gray scale so a wall
// of findings does not turn the UI red.

import { cn } from "@/lib/format";

const STYLES: Record<string, string> = {
  critical: "text-accent-bright border-accent-line",
  high: "text-accent border-accent-line",
  medium: "text-muted border-border-strong",
  low: "text-faint border-border",
  info: "text-faint border-border",
};

export default function SeverityBadge({ severity }: { severity: string }) {
  const key = severity.toLowerCase();
  const style = STYLES[key] ?? "text-faint border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        style,
      )}
    >
      {key}
    </span>
  );
}
