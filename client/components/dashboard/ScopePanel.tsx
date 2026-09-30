// Immutable scope + egress. The provisioner writes the scope allowlist before
// the engine starts and it never changes mid-run (overview §7); the egress
// matrix (§4.1) is fixed for every engagement. This panel states both so the
// operator can see exactly what the run is allowed to touch.

import { cn } from "@/lib/format";
import type { PhaseData } from "@/lib/events";
import { CheckIcon, BanIcon } from "./icons";

const EGRESS: { from: string; to: string; rule: "allow" | "deny" }[] = [
  { from: "Attacker", to: "Target", rule: "allow" },
  { from: "Attacker", to: "Model API", rule: "allow" },
  { from: "Sandbox", to: "Control plane", rule: "allow" },
  { from: "Attacker", to: "Open internet", rule: "deny" },
  { from: "Target", to: "Open internet", rule: "deny" },
];

function portList(ports: unknown): string {
  if (Array.isArray(ports)) return ports.join(", ");
  if (ports == null) return "discovering…";
  return String(ports);
}

export default function ScopePanel({
  host,
  ports,
}: {
  host?: string;
  ports?: PhaseData["ports"];
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-faint">Target</span>
        <span className="font-mono text-sm text-text">
          {host ?? "awaiting deploy"}
        </span>
        <span className="font-mono text-xs text-muted">
          ports {portList(ports)}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-faint">Egress</span>
        <ul className="flex flex-col divide-y divide-white/5">
          {EGRESS.map((e) => (
            <li
              key={`${e.from}-${e.to}`}
              className="flex items-center justify-between gap-3 py-1.5 text-sm"
            >
              <span className="text-muted">
                {e.from} <span className="text-faint">to</span> {e.to}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 text-xs font-medium",
                  e.rule === "deny" ? "text-accent-bright" : "text-faint",
                )}
              >
                {e.rule === "deny" ? (
                  <BanIcon size={13} />
                ) : (
                  <CheckIcon size={13} />
                )}
                {e.rule === "deny" ? "Deny" : "Allow"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
