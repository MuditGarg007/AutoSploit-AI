// The attack surface as the operator should picture it: the deployed target
// host and the ports discovery exposed, with findings pinned to the port they
// name. The engine does not emit a structured port-to-finding link, so the pin
// is a light heuristic (the port number appears in the finding's title or
// evidence); it is a hint, not a claim, and unmatched findings are counted
// separately below. Service labels for well-known ports are hints too.

import { cn } from "@/lib/format";
import type { FindingData } from "@/lib/events";

const SERVICE: Record<number, string> = {
  22: "ssh",
  80: "http",
  443: "https",
  3306: "mysql",
  5432: "postgres",
  6379: "redis",
  8080: "http",
  27017: "mongo",
};

function toPorts(ports: unknown): number[] {
  if (!Array.isArray(ports)) return [];
  return ports.filter((p): p is number => typeof p === "number");
}

// Findings whose title or evidence names this port number as a standalone token.
function findingsForPort(
  port: number,
  findings: (FindingData & { ts: string })[],
): number {
  const re = new RegExp(`\\b${port}\\b`);
  return findings.filter(
    (f) => re.test(f.title) || (f.evidence ? re.test(f.evidence) : false),
  ).length;
}

export default function SurfaceMap({
  host,
  ports,
  findings,
}: {
  host?: string;
  ports?: unknown;
  findings: (FindingData & { ts: string })[];
}) {
  const list = toPorts(ports);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
          Target
        </span>
        <span className="break-all font-mono text-sm text-text">
          {host ?? "awaiting deploy"}
        </span>
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-faint">No ports discovered yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/5">
          {list.map((port) => {
            const n = findingsForPort(port, findings);
            return (
              <li
                key={port}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-sm text-text tabular-nums">
                    {port}
                  </span>
                  {SERVICE[port] && (
                    <span className="font-mono text-xs text-faint">
                      {SERVICE[port]}
                    </span>
                  )}
                </span>
                {n > 0 && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded border border-accent-line px-1.5 py-0.5 font-mono text-[10px] text-accent-bright",
                    )}
                  >
                    {n} {n === 1 ? "finding" : "findings"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
