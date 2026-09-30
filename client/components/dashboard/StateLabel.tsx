// Engagement lifecycle state as a plain mono label. No LED dots, no blinking
// (design rules). Burgundy is reserved for the states that actually need
// weight: halted and failed. Everything else is quiet text.

import { cn } from "@/lib/format";
import type { EngagementState } from "@/lib/events";

const LABELS: Record<EngagementState, string> = {
  queued: "Queued",
  dispatched: "Dispatched",
  provisioning: "Provisioning",
  deploying: "Deploying",
  attacking: "Attacking",
  completed: "Completed",
  halted: "Halted",
  failed: "Failed",
  tearing_down: "Tearing down",
  archived: "Archived",
};

const DANGER: EngagementState[] = ["halted", "failed"];
const ACTIVE: EngagementState[] = [
  "provisioning",
  "deploying",
  "attacking",
  "tearing_down",
];

export default function StateLabel({
  state,
  className,
}: {
  state: EngagementState;
  className?: string;
}) {
  const danger = DANGER.includes(state);
  const active = ACTIVE.includes(state);
  return (
    <span
      className={cn(
        "text-sm font-medium",
        danger ? "text-accent-bright" : active ? "text-text" : "text-faint",
        className,
      )}
    >
      {LABELS[state]}
    </span>
  );
}
