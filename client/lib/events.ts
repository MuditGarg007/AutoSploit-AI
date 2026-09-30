// Typed mirror of the harness event contract
// (packages/contracts/src/event-schema.ts, generated from
// harness/contracts/contract.schema.json). The dashboard consumes this shape
// off the SSE last-mile: GET /engagements/:id/stream. Keep these types aligned
// with the contract so swapping the mock source for the live socket is a no-op
// for every component downstream.

export type EventType =
  | "phase"
  | "tool_call"
  | "tool_result"
  | "finding"
  | "cost"
  | "refusal"
  | "halt";

export interface PhaseData {
  stage: string;
  summary?: string;
  reasoning?: string;
  cause?: string;
  host?: string;
  ports?: unknown;
  attempt?: number;
  nudges?: number;
}

export interface ToolCallData {
  id: string | null;
  name: string;
  args?: Record<string, unknown>;
}

export interface ToolResultData {
  id: string | null;
  name?: string | null;
  is_error?: boolean;
  error?: string;
  truncated?: boolean;
}

// Severity is a free string in the contract; these are the values the engine
// emits today. Anything else falls through to a neutral rendering.
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface FindingData {
  id: string;
  title: string;
  severity: string;
  evidence?: string;
  repro?: string;
}

export interface CostData {
  usd?: number;
  tokens?: number;
  tool_calls?: number;
  caps?: Record<string, number>;
  turn?: Record<string, unknown>;
}

export interface RefusalData {
  reason: string;
  model?: string | null;
}

export interface HaltData {
  reason?: string;
  cause?: string;
  caps?: Record<string, number>;
}

// Discriminated union keyed on `type`. `id` is the Redis Stream cursor
// (ms-seq) delivered as the SSE event id, the Last-Event-ID resume token.
interface Base {
  id: string;
  ts: string;
}

export type EngagementEvent =
  | (Base & { type: "phase"; data: PhaseData })
  | (Base & { type: "tool_call"; data: ToolCallData })
  | (Base & { type: "tool_result"; data: ToolResultData })
  | (Base & { type: "finding"; data: FindingData })
  | (Base & { type: "cost"; data: CostData })
  | (Base & { type: "refusal"; data: RefusalData })
  | (Base & { type: "halt"; data: HaltData });

// Authoritative lifecycle states (control-plane lifecycle.schema.ts).
export type EngagementState =
  | "queued"
  | "dispatched"
  | "provisioning"
  | "deploying"
  | "attacking"
  | "completed"
  | "halted"
  | "failed"
  | "tearing_down"
  | "archived";

export const TERMINAL_STATES: EngagementState[] = [
  "completed",
  "halted",
  "failed",
  "archived",
];

export function isTerminal(state: EngagementState): boolean {
  return TERMINAL_STATES.includes(state);
}

export const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function severityRank(s: string): number {
  return SEVERITY_RANK[s.toLowerCase()] ?? 99;
}

// A tool call paired with its result once it lands. The feed renders these:
// a call shows as pending until its matching tool_result (same id) arrives.
export interface ToolExchange {
  id: string | null;
  key: string; // stable react key even when id is null
  name: string;
  args?: Record<string, unknown>;
  ts: string;
  result?: ToolResultData;
  resultTs?: string;
}

// Reduced view of the whole stream. useEngagementStream builds this; every
// panel reads a slice of it.
export interface EngagementView {
  phases: (PhaseData & { ts: string })[];
  currentStage?: string;
  host?: string;
  ports?: unknown;
  tools: ToolExchange[];
  findings: (FindingData & { ts: string })[];
  cost?: CostData;
  refusal?: RefusalData & { ts: string };
  halt?: HaltData & { ts: string };
  lastEventId?: string;
  eventCount: number;
}

export function emptyView(): EngagementView {
  return { phases: [], tools: [], findings: [], eventCount: 0 };
}

// Fold one event into the running view. Pure, no I/O, so it is trivially
// testable and reused by both the live socket and the mock source.
export function reduceEvent(
  view: EngagementView,
  ev: EngagementEvent,
): EngagementView {
  const next: EngagementView = {
    ...view,
    lastEventId: ev.id,
    eventCount: view.eventCount + 1,
  };

  switch (ev.type) {
    case "phase": {
      next.phases = [...view.phases, { ...ev.data, ts: ev.ts }];
      next.currentStage = ev.data.stage;
      if (ev.data.host) next.host = ev.data.host;
      if (ev.data.ports !== undefined) next.ports = ev.data.ports;
      break;
    }
    case "tool_call": {
      const exchange: ToolExchange = {
        id: ev.data.id,
        key: ev.data.id ?? `${ev.data.name}-${ev.id}`,
        name: ev.data.name,
        args: ev.data.args,
        ts: ev.ts,
      };
      next.tools = [...view.tools, exchange];
      break;
    }
    case "tool_result": {
      // Attach to the most recent unresolved call with a matching id.
      let matched = false;
      next.tools = view.tools.map((t) => {
        if (!matched && t.id === ev.data.id && !t.result) {
          matched = true;
          return { ...t, result: ev.data, resultTs: ev.ts };
        }
        return t;
      });
      if (!matched) {
        // Orphan result (call arrived before subscribe / replay gap): show it.
        next.tools = [
          ...next.tools,
          {
            id: ev.data.id,
            key: `orphan-${ev.id}`,
            name: ev.data.name ?? "unknown",
            ts: ev.ts,
            result: ev.data,
            resultTs: ev.ts,
          },
        ];
      }
      break;
    }
    case "finding": {
      // De-dupe by id (replay can re-deliver).
      if (view.findings.some((f) => f.id === ev.data.id)) break;
      next.findings = [...view.findings, { ...ev.data, ts: ev.ts }];
      break;
    }
    case "cost": {
      next.cost = ev.data;
      break;
    }
    case "refusal": {
      next.refusal = { ...ev.data, ts: ev.ts };
      break;
    }
    case "halt": {
      next.halt = { ...ev.data, ts: ev.ts };
      break;
    }
  }

  return next;
}
