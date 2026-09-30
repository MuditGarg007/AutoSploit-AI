"use client";

// Findings table, most severe first. Neon style: a quiet sentence-case header
// row, then one row per finding separated by full-width hairlines. The severity
// badge is the row's leading marker, the id sits in mono on the right. Rows with
// evidence or repro expand in place. Severity ordering uses the contract's rank;
// ties keep arrival order.

import { useState } from "react";
import { cn, fmtTime } from "@/lib/format";
import { severityRank, type FindingData } from "@/lib/events";
import SeverityBadge from "./SeverityBadge";
import { ChevronRightIcon } from "./icons";

function Header() {
  return (
    <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3 text-xs font-medium text-faint">
      <span>Finding</span>
      <span className="ml-auto">ID</span>
    </div>
  );
}

function FindingRow({ f }: { f: FindingData & { ts: string } }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(f.evidence || f.repro);
  return (
    <div className="border-b border-white/[0.06] last:border-b-0">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors",
          expandable && "cursor-pointer hover:bg-white/[0.03]",
        )}
      >
        <SeverityBadge severity={f.severity} />
        <span className="min-w-0 truncate text-sm text-text">{f.title}</span>
        <span className="ml-auto font-mono text-[10px] text-faint">{f.id}</span>
        {expandable && (
          <ChevronRightIcon
            size={14}
            className={cn(
              "shrink-0 text-faint transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-4">
          {f.evidence && (
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
                Evidence
              </span>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {f.evidence}
              </p>
            </div>
          )}
          {f.repro && (
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
                Repro
              </span>
              <pre className="mt-1 overflow-x-auto rounded-md border border-white/10 bg-black p-3 font-mono text-[11px] leading-relaxed text-muted">
                {f.repro}
              </pre>
            </div>
          )}
          <span className="font-mono text-[10px] text-faint">
            {fmtTime(f.ts)}
          </span>
        </div>
      )}
    </div>
  );
}

export default function FindingsTable({
  findings,
}: {
  findings: (FindingData & { ts: string })[];
}) {
  if (findings.length === 0) {
    return <p className="px-4 py-6 text-sm text-faint">No findings yet.</p>;
  }
  const sorted = [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  return (
    <div>
      <Header />
      {sorted.map((f) => (
        <FindingRow key={f.id} f={f} />
      ))}
    </div>
  );
}
