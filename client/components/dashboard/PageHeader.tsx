// Page header for dashboard views. A breadcrumb line, a large title with an
// optional subtitle, and a right-aligned slot for actions or status. Closes with
// a hairline bottom border so the content below reads as a new section, matching
// the Neon-style vibe without any card chrome.

import Link from "next/link";
import { cn } from "@/lib/format";
import { ChevronRightIcon } from "./icons";

export type Crumb = { label: string; href?: string };

export default function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
  titleMono,
}: {
  title: string;
  subtitle?: string;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  titleMono?: boolean;
}) {
  return (
    <header className="border-b border-white/10 pb-6">
      {crumbs && crumbs.length > 0 && (
        <nav className="mb-3 flex items-center gap-1.5 font-mono text-xs text-faint">
          {crumbs.map((c, i) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRightIcon size={12} className="text-faint" />}
              {c.href ? (
                <Link
                  href={c.href}
                  className="transition-colors hover:text-muted"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="text-muted">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1
            className={cn(
              "truncate text-2xl font-semibold tracking-tight text-text",
              titleMono && "font-mono text-xl tracking-normal",
            )}
          >
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-3">{actions}</div>}
      </div>
    </header>
  );
}
