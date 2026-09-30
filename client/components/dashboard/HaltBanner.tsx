// Surfaced when the run stops short: a budget/scope halt, or a model refusal.
// Both are safe outcomes by design (fail-closed), so this is a statement, not an
// error scream, one burgundy hairline, plain text.

import type { HaltData, RefusalData } from "@/lib/events";
import { HaltIcon } from "./icons";

export default function HaltBanner({
  halt,
  refusal,
}: {
  halt?: HaltData & { ts: string };
  refusal?: RefusalData & { ts: string };
}) {
  if (!halt && !refusal) return null;

  const title = halt ? "Run halted" : "Model refusal";
  const reason =
    halt?.reason || halt?.cause || refusal?.reason || "No reason reported.";

  return (
    <div className="flex gap-3 rounded-md border border-accent-line bg-accent-soft p-4">
      <HaltIcon size={16} className="mt-0.5 shrink-0 text-accent-bright" />
      <div>
        <span className="text-sm font-semibold text-accent-bright">{title}</span>
        <p className="mt-1 text-sm text-muted">{reason}</p>
        {refusal?.model && (
          <p className="mt-1 font-mono text-xs text-faint">{refusal.model}</p>
        )}
      </div>
    </div>
  );
}
