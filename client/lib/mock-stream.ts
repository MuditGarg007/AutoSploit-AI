// Deterministic mock engagement, replayed on a timer. Used when no control
// plane is reachable (NEXT_PUBLIC_API_URL unset, or the SSE connection fails in
// local dev) so the live dashboard renders a realistic run without a backend.
// The emitted objects are exactly EngagementEvent, the same shape the SSE
// gateway pushes, so nothing downstream can tell the difference.

import type { EngagementEvent } from "./events";

let seq = 0;
function id(): string {
  seq += 1;
  return `172390000${String(seq).padStart(4, "0")}-0`;
}
function at(offsetMs: number): string {
  return new Date(Date.UTC(2026, 8, 30, 12, 0, 0) + offsetMs).toISOString();
}

// One scripted run against a sample repo. Ordered; the driver walks it with
// gaps roughly proportional to real timing, compressed for the demo.
export const MOCK_SCRIPT: { after: number; ev: Omit<EngagementEvent, "id"> }[] =
  [
    {
      after: 0,
      ev: {
        type: "phase",
        ts: at(0),
        data: {
          stage: "provisioning",
          summary: "Sandbox up, egress default-deny applied",
        },
      },
    },
    {
      after: 900,
      ev: {
        type: "phase",
        ts: at(2000),
        data: {
          stage: "deploying",
          summary: "docker compose up, app + postgres + redis",
          host: "10.42.0.14",
          ports: [8080, 5432, 6379],
        },
      },
    },
    {
      after: 1600,
      ev: {
        type: "phase",
        ts: at(6000),
        data: {
          stage: "attacking",
          summary: "Scope allowlist locked, engine started",
          reasoning:
            "Three ports discovered. Postgres on 5432 is reachable from the app tier, checking for unauthenticated access first.",
          host: "10.42.0.14",
          ports: [8080, 5432, 6379],
        },
      },
    },
    {
      after: 700,
      ev: {
        type: "tool_call",
        ts: at(7000),
        data: {
          id: "call_01",
          name: "http_request",
          args: { method: "GET", path: "/", host: "10.42.0.14:8080" },
        },
      },
    },
    {
      after: 600,
      ev: {
        type: "tool_result",
        ts: at(7600),
        data: { id: "call_01", name: "http_request", is_error: false },
      },
    },
    {
      after: 500,
      ev: {
        type: "tool_call",
        ts: at(8200),
        data: {
          id: "call_02",
          name: "port_probe",
          args: { host: "10.42.0.14", port: 5432 },
        },
      },
    },
    {
      after: 900,
      ev: {
        type: "tool_result",
        ts: at(9100),
        data: { id: "call_02", name: "port_probe", is_error: false },
      },
    },
    {
      after: 400,
      ev: {
        type: "cost",
        ts: at(9200),
        data: {
          usd: 0.42,
          tokens: 48120,
          tool_calls: 2,
          caps: { usd: 5, tokens: 2000000, tool_calls: 400 },
        },
      },
    },
    {
      after: 700,
      ev: {
        type: "tool_call",
        ts: at(10000),
        data: {
          id: "call_03",
          name: "sql_probe",
          args: { host: "10.42.0.14", port: 5432, auth: "none" },
        },
      },
    },
    {
      after: 1100,
      ev: {
        type: "tool_result",
        ts: at(11100),
        data: { id: "call_03", name: "sql_probe", is_error: false },
      },
    },
    {
      after: 300,
      ev: {
        type: "finding",
        ts: at(11400),
        data: {
          id: "F-001",
          severity: "critical",
          title: "Unauthenticated Postgres exposed on 5432",
          evidence:
            "Connected to postgres://10.42.0.14:5432 with no credentials. Enumerated 6 tables including users, sessions.",
          repro:
            "psql -h 10.42.0.14 -p 5432 -U postgres -c '\\dt', connects without a password.",
        },
      },
    },
    {
      after: 900,
      ev: {
        type: "tool_call",
        ts: at(12300),
        data: {
          id: "call_04",
          name: "http_request",
          args: {
            method: "POST",
            path: "/api/login",
            host: "10.42.0.14:8080",
          },
        },
      },
    },
    {
      after: 800,
      ev: {
        type: "tool_result",
        ts: at(13100),
        data: {
          id: "call_04",
          name: "http_request",
          is_error: true,
          error: "500 Internal Server Error, stack trace leaked in body",
          truncated: true,
        },
      },
    },
    {
      after: 400,
      ev: {
        type: "finding",
        ts: at(13500),
        data: {
          id: "F-002",
          severity: "high",
          title: "SQL injection in /api/login (username field)",
          evidence:
            "Payload ' OR '1'='1 returned a 500 with a leaked SQL error naming the users table and the query text.",
          repro:
            "curl -X POST 10.42.0.14:8080/api/login -d \"username=' OR '1'='1&password=x\"",
        },
      },
    },
    {
      after: 700,
      ev: {
        type: "finding",
        ts: at(14200),
        data: {
          id: "F-003",
          severity: "medium",
          title: "Verbose error responses leak stack traces",
          evidence:
            "Application returns full stack traces on 500, exposing framework version and file paths.",
        },
      },
    },
    {
      after: 600,
      ev: {
        type: "cost",
        ts: at(14800),
        data: {
          usd: 1.18,
          tokens: 132400,
          tool_calls: 4,
          caps: { usd: 5, tokens: 2000000, tool_calls: 400 },
        },
      },
    },
    {
      after: 1200,
      ev: {
        type: "phase",
        ts: at(16000),
        data: {
          stage: "completed",
          summary: "Engine finished: 3 findings, budget within caps",
        },
      },
    },
  ];

export interface MockHandle {
  cancel: () => void;
}

// Drive the script through a callback with realistic gaps. Returns a handle so
// the caller can cancel on unmount.
export function driveMockStream(
  onEvent: (ev: EngagementEvent) => void,
  opts: { speed?: number } = {},
): MockHandle {
  const speed = opts.speed ?? 1;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let elapsed = 0;
  for (const step of MOCK_SCRIPT) {
    elapsed += step.after;
    const t = setTimeout(() => {
      onEvent({ ...step.ev, id: id() } as EngagementEvent);
    }, elapsed / speed);
    timers.push(t);
  }
  return {
    cancel: () => {
      for (const t of timers) clearTimeout(t);
    },
  };
}
