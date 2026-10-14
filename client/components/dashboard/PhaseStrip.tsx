// A compact top-of-cockpit progress strip over the canonical engagement
// lifecycle: provision, deploy, attack, finish. The engine's own stages are
// adaptive (it loops within "attacking"), so this strip tracks the lifecycle
// arc, not every emitted phase; the full per-phase detail lives in the activity
// console below. Steps before the current one read as done, the current step
// carries the burgundy fill, later steps stay faint. A halted or failed run
// paints the final step in the accent. No blinking markers (design rules): the
// state is in the fill and the word.

import { cn } from "@/lib/format";
import type { EngagementState } from "@/lib/events";

type StepId = "provision" | "deploy" | "attack" | "finish";
const STEPS: { id: StepId; label: string }[] = [
  { id: "provision", label: "Provision" },
  { id: "deploy", label: "Deploy" },
  { id: "attack", label: "Attack" },
  { id: "finish", label: "Finish" },
];

// Which step the lifecycle state sits in.
function stepIndex(state: EngagementState): number {
  switch (state) {
    case "queued":
    case "dispatched":
    case "provisioning":
      return 0;
    case "deploying":
      return 1;
    case "attacking":
      return 2;
    case "completed":
    case "halted":
    case "failed":
    case "tearing_down":
    case "archived":
      return 3;
    default:
      return 0;
  }
}

export default function PhaseStrip({ state }: { state: EngagementState }) {
  const current = stepIndex(state);
  const danger = state === "halted" || state === "failed";

  return (
    <div className="flex gap-2">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s.id} className="flex flex-1 flex-col gap-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-white/5">
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500",
                  active
                    ? danger
                      ? "w-full bg-accent-bright"
                      : "w-full bg-accent"
                    : done
                      ? "w-full bg-white/30"
                      : "w-0",
                )}
              />
            </div>
            <span
              className={cn(
                "text-[11px] font-medium",
                active
                  ? danger
                    ? "text-accent-bright"
                    : "text-text"
                  : done
                    ? "text-muted"
                    : "text-faint",
              )}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
