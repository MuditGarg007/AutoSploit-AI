"use client";

// Engagement index table, Neon style. A search field, a quiet sentence-case
// header row, then one row per run that clicks into the live view. Each row
// leads with a crosshair marker and a bold name, metrics in mono, state as a
// plain word (burgundy only for halted / failed via StateLabel). Rows are
// separated by full-width hairlines, not cards. Reads mock rows for now; swaps
// to the control-plane list endpoint later without touching the row markup.

import { useMemo, useState } from "react";
import Link from "next/link";
import { fmtUsd } from "@/lib/format";
import StateLabel from "./StateLabel";
import { ChevronRightIcon, SearchIcon, TargetIcon } from "./icons";
import type { EngagementRow } from "@/lib/mock-engagements";

const COLS =
  "grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_9rem_7rem_6rem_2rem] items-center gap-4";

function fmtStarted(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function Header() {
  return (
    <div
      className={`${COLS} border-b border-white/10 px-4 py-3 text-xs font-medium text-faint`}
    >
      <span>Repository</span>
      <span className="hidden sm:block">State</span>
      <span className="hidden text-right sm:block">Findings</span>
      <span className="hidden text-right sm:block">Spend</span>
      <span className="hidden sm:block" />
    </div>
  );
}

function Row({ e }: { e: EngagementRow }) {
  return (
    <Link
      href={`/dashboard/${e.id}`}
      className={`${COLS} group border-b border-white/[0.06] px-4 py-4 transition-colors last:border-b-0 hover:bg-white/[0.03]`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <TargetIcon
          size={16}
          className="shrink-0 text-faint transition-colors group-hover:text-muted"
        />
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-text">
            {e.repo}
          </span>
          <span className="mt-0.5 block font-mono text-xs text-faint">
            {fmtStarted(e.startedTs)}
          </span>
        </div>
      </div>

      {/* mobile compact */}
      <div className="flex items-center gap-4 sm:hidden">
        <StateLabel state={e.state} />
        <span className="font-mono text-sm text-faint tabular-nums">
          {e.findings}
        </span>
      </div>

      {/* desktop columns */}
      <StateLabel state={e.state} className="hidden sm:block" />
      <span className="hidden text-right font-mono text-sm text-muted tabular-nums sm:block">
        {e.findings}
      </span>
      <span className="hidden text-right font-mono text-sm text-muted tabular-nums sm:block">
        {fmtUsd(e.usd)}
      </span>
      <ChevronRightIcon
        size={16}
        className="hidden justify-self-end text-faint transition-colors group-hover:text-muted sm:block"
      />
    </Link>
  );
}

export default function EngagementList({ rows }: { rows: EngagementRow[] }) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((e) => e.repo.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div>
      <div className="border-b border-white/10 p-4">
        <div className="relative">
          <SearchIcon
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            type="text"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Search repositories"
            aria-label="Search repositories"
            className="h-10 w-full rounded-md border border-white/10 bg-surface-2 pl-9 pr-3 text-sm text-text placeholder:text-faint transition-colors focus:border-white/20 focus:outline-none focus:ring-2 focus:ring-accent-soft"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-16 text-center">
          <p className="text-sm text-muted">No engagements yet.</p>
          <p className="mt-1 font-mono text-xs text-faint">
            Connect a repo to start a run.
          </p>
        </div>
      ) : matches.length === 0 ? (
        <div className="px-4 py-16 text-center">
          <p className="text-sm text-muted">No repositories match.</p>
          <p className="mt-1 font-mono text-xs text-faint">{query}</p>
        </div>
      ) : (
        <>
          <Header />
          {matches.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </>
      )}
    </div>
  );
}
