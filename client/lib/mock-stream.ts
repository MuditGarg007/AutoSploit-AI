// Deterministic mock engagement, replayed on a timer. Used when no control
// plane is reachable (NEXT_PUBLIC_API_URL unset, or the SSE connection fails in
// local dev) so the live dashboard renders a realistic run without a backend.
// The emitted objects are exactly EngagementEvent, the same shape the SSE
// gateway pushes, so nothing downstream can tell the difference.
//
// Tool results carry the full structured shapes the harness emits (cmd / stdout
// for run_shell, method / url / status / body for http_request), so the live
// console shows the real commands and output, not a bare "done".

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
          summary: "Sandbox up, egress default-deny applied.",
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
          summary: "docker compose up: app, postgres, redis.",
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
          summary: "Scope allowlist locked, engine started.",
          reasoning:
            "Three ports exposed. I will fingerprint them before touching anything, so I know what I am attacking rather than guessing.",
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
          name: "run_shell",
          args: { cmd: "nmap -sV -p 8080,5432,6379 10.42.0.14" },
        },
      },
    },
    {
      after: 1400,
      ev: {
        type: "tool_result",
        ts: at(8400),
        data: {
          id: "call_01",
          name: "run_shell",
          is_error: false,
          cmd: "nmap -sV -p 8080,5432,6379 10.42.0.14",
          exit_code: 0,
          stdout:
            "Starting Nmap 7.94 ( https://nmap.org )\n" +
            "Nmap scan report for 10.42.0.14\n" +
            "PORT     STATE SERVICE    VERSION\n" +
            "8080/tcp open  http       Werkzeug/3.0.1 Python/3.12\n" +
            "5432/tcp open  postgresql PostgreSQL 15.4\n" +
            "6379/tcp open  redis      Redis 7.2\n" +
            "Service detection performed. 3 ports scanned.",
          stderr: "",
        },
      },
    },
    {
      after: 500,
      ev: {
        type: "phase",
        ts: at(8900),
        data: {
          stage: "attacking",
          reasoning:
            "Postgres 15.4 is reachable from this tier. An unauthenticated database is the highest-impact thing I can check cheaply, so I try that first.",
        },
      },
    },
    {
      after: 400,
      ev: {
        type: "cost",
        ts: at(9300),
        data: {
          usd: 0.42,
          tokens: 48120,
          tool_calls: 1,
          caps: { usd: 5, tokens: 2000000, tool_calls: 400 },
          turn: { usd: 0.42, tokens: 48120 },
        },
      },
    },
    {
      after: 700,
      ev: {
        type: "tool_call",
        ts: at(10000),
        data: {
          id: "call_02",
          name: "run_shell",
          args: {
            cmd: "psql -h 10.42.0.14 -p 5432 -U postgres -c '\\dt'",
          },
        },
      },
    },
    {
      after: 1100,
      ev: {
        type: "tool_result",
        ts: at(11100),
        data: {
          id: "call_02",
          name: "run_shell",
          is_error: false,
          cmd: "psql -h 10.42.0.14 -p 5432 -U postgres -c '\\dt'",
          exit_code: 0,
          stdout:
            "          List of relations\n" +
            " Schema |   Name    | Type  |  Owner\n" +
            "--------+-----------+-------+----------\n" +
            " public | users     | table | postgres\n" +
            " public | sessions  | table | postgres\n" +
            " public | api_keys  | table | postgres\n" +
            "(3 rows)",
          stderr: "",
        },
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
            "Connected to postgres://10.42.0.14:5432 with no credentials and listed 3 tables including users and api_keys.",
          repro:
            "psql -h 10.42.0.14 -p 5432 -U postgres -c '\\dt' connects without a password.",
        },
      },
    },
    {
      after: 900,
      ev: {
        type: "tool_call",
        ts: at(12300),
        data: {
          id: "call_03",
          name: "http_request",
          args: {
            method: "POST",
            url: "http://10.42.0.14:8080/api/login",
            body: "username=' OR '1'='1&password=x",
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
          id: "call_03",
          name: "http_request",
          is_error: false,
          method: "POST",
          url: "http://10.42.0.14:8080/api/login",
          status: 500,
          headers: {
            "content-type": "text/html; charset=utf-8",
            server: "Werkzeug/3.0.1",
          },
          body:
            "psycopg2.errors.SyntaxError: unterminated quoted string at or near \"'1'\"\n" +
            "LINE 1: SELECT * FROM users WHERE username='' OR '1'='1' AND ...\n" +
            "Traceback (most recent call last):\n" +
            "  File \"/app/api/auth.py\", line 42, in login",
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
            "Payload ' OR '1'='1 returned a 500 with a leaked SQL error naming the users table and the raw query text.",
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
            "The app returns full Python tracebacks on 500, exposing framework version and file paths under /app.",
          repro: "Any request that triggers a 500 returns the traceback in the body.",
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
          tool_calls: 3,
          caps: { usd: 5, tokens: 2000000, tool_calls: 400 },
          turn: { usd: 0.76, tokens: 84280 },
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
          summary:
            "Engine finished: 3 findings (1 critical, 1 high, 1 medium), budget within caps.",
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
