// The one place that knows about the control plane. Every page/component reads
// engagements through these functions, never fetch() directly, so swapping the
// mock source for the live backend is a config change (set NEXT_PUBLIC_API_URL),
// not a rewrite. Mirrors the fallback contract in hooks/useEngagementStream: when
// no API base is configured, return mock; when a base is set but the request
// cannot be reached, fall back cleanly so the dashboard stays renderable.
//
// Endpoints (docs/control-plane.md §4):
//   GET  /engagements              -> list (slice C)
//   GET  /engagements/:id          -> one engagement (slice C)
//   POST /engagements  { repoId }  -> dispatch (slice C)
//   POST /engagements/:id/abort    -> halt (slice C)
//   GET  /engagements/:id/report   -> assembled report (slice E)
//
// The SSE stream (slice D) is owned by useEngagementStream, not this module.

import type { EngagementState } from "./events";
import {
  MOCK_ENGAGEMENTS,
  findEngagement,
  type EngagementRow,
} from "./mock-engagements";
import { MOCK_REPOS, findRepo, type Repo } from "./mock-repos";
import { getToken, refreshToken } from "./token";

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

// Single fetch path to the control plane. Attaches the Bearer access token when
// present (none on the server, where localStorage is absent — those reads fall
// back to mock), includes credentials so the refresh cookie rides along, and on
// a 401 tries one silent refresh then retries. Callers handle !ok themselves.
async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const run = (token: string | null): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

  let res = await run(getToken());
  if (res.status === 401) {
    const next = await refreshToken();
    if (next) res = await run(next);
  }
  return res;
}

// Thrown for a reachable backend that answered with a non-2xx. A network failure
// (backend unreachable) does not throw this: reads fall back to mock, and create
// synthesizes a mock id, so local dev works with no backend. S3 catches this to
// render the quota 429 and validation 400 paths.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Wire shape of a lifecycle row (control-plane engagements table). Dates arrive
// as ISO strings over JSON. findings/usd are NOT on this row: those are the
// telemetry rollup (slice D), not served by the lifecycle endpoints, so the list
// view shows 0 for them until a rollup endpoint exists.
interface ApiEngagement {
  id: string;
  userId: string;
  repoFullName: string;
  state: EngagementState;
  haltReason: string | null;
  failReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRow(e: ApiEngagement): EngagementRow {
  return {
    id: e.id,
    repo: e.repoFullName,
    state: e.state,
    findings: 0,
    usd: 0,
    startedTs: e.createdAt,
  };
}

function base(): string | undefined {
  return API_BASE;
}

// GET with credentials (the control plane authenticates with its own cookie
// session). Throws ApiError on a non-2xx; lets a network error propagate so the
// callers can distinguish "backend said no" from "no backend".
async function get<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** List the signed-in user's engagements. Falls back to mock. */
export async function listEngagements(): Promise<EngagementRow[]> {
  if (!base()) return MOCK_ENGAGEMENTS;
  try {
    const rows = await get<ApiEngagement[]>("/engagements");
    return rows.map(toRow);
  } catch {
    return MOCK_ENGAGEMENTS;
  }
}

/** One engagement, for the detail header label. Falls back to mock. */
export async function getEngagement(
  id: string,
): Promise<EngagementRow | undefined> {
  if (!base()) return findEngagement(id);
  try {
    return toRow(await get<ApiEngagement>(`/engagements/${encodeURIComponent(id)}`));
  } catch (e) {
    // A real 404 (no such engagement / not owned) should not masquerade as mock
    // data for a different id; only fall back when the backend is unreachable.
    if (e instanceof ApiError) throw e;
    return findEngagement(id);
  }
}

// Wire shape of GET /repos (control-plane repos.service GitHubRepo). Only id /
// fullName / name feed the picker; the rest is ignored here.
interface ApiRepo {
  id: number;
  fullName: string;
  name: string;
}

/** List the user's repos for the picker. Falls back to mock. */
export async function listRepos(): Promise<Repo[]> {
  if (!base()) return MOCK_REPOS;
  try {
    const rows = await get<ApiRepo[]>("/repos");
    return rows.map((r) => ({ id: r.id, fullName: r.fullName, name: r.name }));
  } catch {
    return MOCK_REPOS;
  }
}

/**
 * Deployable gate for one repo (GET /repos/:id/deployable). The form probes this
 * when a repo is picked, to only let a deployable repo be dispatched. On mock the
 * flag is baked into MOCK_REPOS; an unreachable backend falls back to that.
 */
export async function getRepoDeployable(id: number): Promise<boolean> {
  if (!base()) return findRepo(id)?.deployable ?? false;
  try {
    const r = await get<{ fullName: string; deployable: boolean }>(
      `/repos/${id}/deployable`,
    );
    return r.deployable;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return findRepo(id)?.deployable ?? false;
  }
}

/**
 * Dispatch a new engagement. Body is { repoId } only (the repo is chosen from the
 * user's own list; caps/scope are server-side, not form fields). Returns the new
 * engagement id. On an unreachable backend, synthesizes a mock id so the new-run
 * flow works in local dev; a reachable backend's rejection (429 quota, 400 bad
 * repoId) throws ApiError for the caller to render.
 */
export async function createEngagement(input: {
  repoId: number;
}): Promise<{ id: string }> {
  if (!base()) return { id: synthId() };
  let res: Response;
  try {
    res = await authedFetch("/engagements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: input.repoId }),
    });
  } catch {
    // Backend unreachable: mock the dispatch.
    return { id: synthId() };
  }
  if (!res.ok) {
    throw new ApiError(res.status, `POST /engagements -> ${res.status}`);
  }
  const row = (await res.json()) as ApiEngagement;
  return { id: row.id };
}

/** Halt a running engagement. No-op fallback when the backend is unreachable. */
export async function abortEngagement(id: string): Promise<void> {
  if (!base()) return;
  try {
    const res = await authedFetch(
      `/engagements/${encodeURIComponent(id)}/abort`,
      { method: "POST" },
    );
    if (!res.ok) throw new ApiError(res.status, `POST abort -> ${res.status}`);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Unreachable backend: nothing to halt in the mock.
  }
}

// Assembled report (slice E). Dates arrive as ISO strings over JSON.
export interface ReportArtifact {
  key: string;
  url: string | null;
}

export interface ReportFinding {
  sourceId: string;
  severity: string;
  title: string;
  data: unknown;
  observedAt: string;
}

export interface Report {
  engagementId: string;
  state: EngagementState;
  assembledAt: string;
  findings: ReportFinding[];
  artifacts: {
    rendered: ReportArtifact;
    rawLog: ReportArtifact;
    memoryBundle: ReportArtifact;
  };
}

/** Fetch the assembled report. Returns undefined when unavailable on mock. */
export async function getReport(id: string): Promise<Report | undefined> {
  if (!base()) return undefined;
  return get<Report>(`/engagements/${encodeURIComponent(id)}/report`);
}

// A mock engagement id, same shape as the demo stream expects (eng_*).
function synthId(): string {
  return `eng_${Math.random().toString(16).slice(2, 6)}`;
}
