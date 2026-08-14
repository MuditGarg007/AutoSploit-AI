// Generated from harness/contracts/contract.schema.json — do not hand-edit.
// Regenerate via `bun run generate` (or `bun run generate` in packages/contracts).
// Source of truth: harness/src/autosploit_harness/contracts/ (harness.md §9 step 5).

export const CONTRACT_VERSION = '1.0.0';

export const EVENT_TYPES = ['phase', 'tool_call', 'tool_result', 'finding', 'cost', 'refusal', 'halt'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface cost {
  caps: Record<string, unknown>;
  tokens: number;
  tool_calls: number;
  turn?: Record<string, unknown>;
  usd: number;
}


export interface finding {
  evidence: string;
  id: string;
  repro: string;
  severity: string;
  title: string;
}


export interface halt {
  caps?: Record<string, unknown>;
  cause?: string;
  reason?: string;
  stage?: string;
  tokens?: number;
  tool_calls?: number;
  usd?: number;
}


export interface phase {
  attempt?: number;
  cause?: string;
  host?: string;
  nudges?: number;
  ports?: unknown;
  reasoning?: string;
  stage: string;
  summary?: string;
}


export interface refusal {
  model?: string | null;
  reason: string;
}


export interface tool_call {
  args?: Record<string, unknown>;
  id: string | null;
  name: string;
}


export interface tool_result {
  error?: string;
  id: string | null;
  is_error: boolean;
  name: string | null;
  truncated?: boolean;
}


export interface EventEnvelope {
  ts: string;
  type: EventType;
  data: object;
}

export type HarnessEvent =
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'cost'; data: cost })
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'finding'; data: finding })
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'halt'; data: halt })
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'phase'; data: phase })
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'refusal'; data: refusal })
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'tool_call'; data: tool_call })
  | (Omit<EventEnvelope, 'type' | 'data'> & { type: 'tool_result'; data: tool_result })
;

export interface Report {
  attempts: number;
  budget: Record<string, unknown>;
  completed: boolean;
  findings: unknown;
  halt_reason: string | null;
  summary: string | null;
  tool_results: number;
  turns: number;
}

