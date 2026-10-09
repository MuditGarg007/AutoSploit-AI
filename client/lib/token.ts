// Isomorphic auth primitives for the control-plane GitHub-OAuth bridge. No React
// and no "use client" here on purpose: lib/api.ts is imported by server
// components too, so the token accessor must be safe to call where there is no
// `window` (it just reports "no token" there). The React surface lives in
// lib/auth.ts (useAuth), which builds on these.
//
// Flow: "Sign in with GitHub" is a top-level nav to the control plane's
// /auth/github. The backend runs the OAuth handshake, sets an httpOnly refresh
// cookie on the API origin, and redirects to /dashboard?access_token=<jwt>. The
// SPA captures that access token, stores it, and sends it as a Bearer token; it
// is re-minted silently from the refresh cookie at POST /auth/refresh.

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
const TOKEN_KEY = "as_access_token";
const TOKEN_PARAM = "access_token";

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
 * If the OAuth redirect left ?access_token=... on the URL, store it and strip it
 * from the address bar (so it is not kept in history or shared via links).
 * Returns true when a token was captured.
 */
export function captureTokenFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  const token = url.searchParams.get(TOKEN_PARAM);
  if (!token) return false;
  setToken(token);
  url.searchParams.delete(TOKEN_PARAM);
  window.history.replaceState({}, "", url.toString());
  return true;
}

/**
 * Exchange the httpOnly refresh cookie for a fresh access token. Returns the new
 * token, or null when the session is gone. Cross-origin, so credentials must be
 * included to send the cookie.
 */
// A single in-flight refresh shared by every caller. The refresh token rotates
// on each use: the server demotes the presented token to "prev" and, if that
// demoted token is ever presented again, treats it as theft and revokes the
// whole session. So two concurrent POST /auth/refresh calls are fatal: the first
// rotates the cookie, the second still holds the now-stale cookie and gets the
// session revoked (the user is logged out and every stream drops). authedFetch
// (refresh-on-401) and getFreshToken (the SSE path) are independent callers that
// both tend to fire as the access token nears expiry, so without coalescing they
// collide. Sharing one promise presents the cookie exactly once per rotation.
let inflightRefresh: Promise<string | null> | null = null;

export function refreshToken(): Promise<string | null> {
  if (!API_BASE) return Promise.resolve(null);
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
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
  if (!token) return true;
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: unknown };
    if (typeof json.exp !== "number") return true;
    return json.exp * 1000 <= Date.now() + withinSec * 1000;
  } catch {
    return true;
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
