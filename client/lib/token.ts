// Isomorphic auth primitives for the control-plane GitHub-OAuth bridge. No React
// and no "use client" here on purpose: lib/api.ts is imported by server
// components too, so the token accessor must be safe to call where there is no
// `window` (it just reports "no token" there). The React surface lives in
// lib/auth.ts (useAuth), which builds on these.
//
// Flow: "Sign in with GitHub" is a top-level nav to the control plane's
// /auth/github. The backend runs the OAuth handshake, sets an httpOnly refresh
// cookie on the API origin, and redirects to /dashboard with NO token on the
// URL. On load the SPA mints its first access token by calling POST /auth/refresh
// (the cookie rides along via credentials: include), stores it, and sends it as a
// Bearer token. The access token is short-lived and re-minted the same way; the
// refresh token is non-rotating, so repeated/concurrent refreshes are safe.

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
const TOKEN_KEY = "as_access_token";

/** Whether a live control plane is configured (vs. the mock-only demo build). */
export function hasBackend(): boolean {
  return !!API_BASE;
}

/** The sign-in entry point: a top-level navigation, not a fetch. */
export function signInUrl(): string {
  return `${API_BASE}/auth/github`;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private-mode / blocked storage: run tokenless, reads fall back to mock */
  }
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Exchange the httpOnly refresh cookie for a fresh access token. Returns the new
 * token, or null when the session is gone. Cross-origin, so credentials must be
 * included to send the cookie.
 */
// Refresh is coalesced at two levels. The refresh token is non-rotating, so
// concurrent refreshes are already SAFE (each just mints another access token) —
// this coalescing is purely to avoid a stampede of identical POSTs:
//   1. In-tab: one shared in-flight promise, so authedFetch (refresh-on-401),
//      getFreshToken (the SSE path), and the proactive timer in useAuth collapse
//      into a single request.
//   2. Cross-tab: the Web Locks API ("as-refresh") serializes refreshes across
//      tabs and writes the fresh token to localStorage, which other tabs read via
//      getToken(). Locks are best-effort; where unavailable we fall back to the
//      in-tab promise, which is still correct (just chattier).
let inflightRefresh: Promise<string | null> | null = null;

export function refreshToken(): Promise<string | null> {
  if (!API_BASE) return Promise.resolve(null);
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = refreshWithLock().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

// Serialize the refresh across tabs when the Web Locks API is present. The lock
// holder does the network round-trip; a tab that waited on the lock first checks
// whether the holder already left a fresh token in localStorage and reuses it,
// so only one POST goes out per expiry window across the whole browser.
async function refreshWithLock(): Promise<string | null> {
  const locks = (
    typeof navigator !== "undefined" ? navigator.locks : undefined
  ) as LockManager | undefined;
  if (!locks?.request) return doRefresh();

  const before = getToken();
  return locks.request("as-refresh", async () => {
    const current = getToken();
    // Another tab refreshed while we waited for the lock: reuse its token.
    if (current && current !== before && !tokenExpiresWithin(current, 30)) {
      return current;
    }
    return doRefresh();
  });
}

async function doRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) return null;
    setToken(body.accessToken);
    return body.accessToken;
  } catch {
    return null;
  }
}

/**
 * True when `token` is missing, unparseable, or expires within `withinSec`
 * seconds. Decodes the JWT payload locally (no network) to read `exp`; a token
 * we cannot read is treated as expired so the caller refreshes rather than
 * sending something the server will reject. Never throws.
 */
export function tokenExpiresWithin(
  token: string | null,
  withinSec: number,
): boolean {
  const expMs = accessTokenExpiryMs(token);
  if (expMs === null) return true;
  return expMs <= Date.now() + withinSec * 1000;
}

/**
 * The epoch-ms expiry (`exp`) of a JWT access token, read locally with no
 * network. Returns null when the token is missing or its `exp` is unreadable, so
 * callers treat it as "refresh now". Never throws. Used to schedule the proactive
 * refresh so the UI re-mints before the token dies rather than after a 401.
 */
export function accessTokenExpiryMs(token: string | null): number | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: unknown };
    if (typeof json.exp !== "number") return null;
    return json.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * The access token to send now, refreshed first if it is missing or about to
 * expire. Keeps the happy path network-free (a comfortably-valid token is
 * returned as-is, so the refresh cookie is not rotated needlessly) and falls
 * back to whatever token we hold if the refresh fails. Returns null only when
 * there is no usable token at all.
 */
export async function getFreshToken(withinSec = 60): Promise<string | null> {
  const token = getToken();
  if (!tokenExpiresWithin(token, withinSec)) return token;
  const refreshed = await refreshToken();
  return refreshed ?? token;
}

/** Revoke the server session and drop the local token (best effort). */
export async function signOutRequest(): Promise<void> {
  const token = getToken();
  if (API_BASE && token) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      /* best effort */
    }
  }
  clearToken();
}
