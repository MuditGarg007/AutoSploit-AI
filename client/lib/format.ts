// Small formatting helpers for the dashboard. Metrics render in Geist Mono, so
// keep these compact and locale-stable.

export function fmtUsd(n: number | undefined): string {
  if (n === undefined) return "$0.00";
  return `$${n.toFixed(2)}`;
}

export function fmtInt(n: number | undefined): string {
  if (n === undefined) return "0";
  return n.toLocaleString("en-US");
}

// 48120 -> "48.1k", 1324000 -> "1.32M". Used for token counts.
export function fmtCompact(n: number | undefined): string {
  if (n === undefined) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Elapsed between two ISO timestamps, as m:ss or h:mm:ss.
export function fmtElapsed(fromTs: string, toTs: string): string {
  const ms = new Date(toTs).getTime() - new Date(fromTs).getTime();
  if (Number.isNaN(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Join class names, dropping falsy values. Avoids pulling in clsx for this.
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
