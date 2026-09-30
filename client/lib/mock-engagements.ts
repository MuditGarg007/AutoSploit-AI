// Mock engagement index rows for local dev without a control plane. The index
// page renders these until the control-plane engagement list is wired in; shapes
// mirror the fields the list endpoint will return (lifecycle + telemetry
// rollup).

import type { EngagementState } from "./events";

export interface EngagementRow {
  id: string;
  repo: string;
  state: EngagementState;
  findings: number;
  usd: number;
  startedTs: string;
}

export const MOCK_ENGAGEMENTS: EngagementRow[] = [
  {
    id: "eng_live",
    repo: "acme/storefront",
    state: "attacking",
    findings: 2,
    usd: 1.18,
    startedTs: "2026-09-30T11:58:00Z",
  },
  {
    id: "eng_9f2c",
    repo: "acme/billing-api",
    state: "completed",
    findings: 5,
    usd: 3.4,
    startedTs: "2026-09-29T16:20:00Z",
  },
  {
    id: "eng_7a1d",
    repo: "acme/internal-tools",
    state: "halted",
    findings: 1,
    usd: 5.0,
    startedTs: "2026-09-29T09:05:00Z",
  },
  {
    id: "eng_3b88",
    repo: "acme/marketing-site",
    state: "failed",
    findings: 0,
    usd: 0.12,
    startedTs: "2026-09-28T14:41:00Z",
  },
];

export function findEngagement(id: string): EngagementRow | undefined {
  return MOCK_ENGAGEMENTS.find((e) => e.id === id);
}
