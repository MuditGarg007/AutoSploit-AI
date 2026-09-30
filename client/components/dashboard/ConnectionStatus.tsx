// Stream connection state as a plain word. No pulsing dot (design rules), the
// word itself carries the state, burgundy only when the connection is degraded.

import { cn } from "@/lib/format";
import type { StreamStatus } from "@/hooks/useEngagementStream";

const LABEL: Record<StreamStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
  mock: "Demo stream",
};

export default function ConnectionStatus({ status }: { status: StreamStatus }) {
  const degraded = status === "reconnecting" || status === "closed";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        degraded
          ? "border-accent-line text-accent-bright"
          : "border-white/10 text-faint",
      )}
    >
      {LABEL[status]}
    </span>
  );
}
