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
export async function refreshToken(): Promise<string | null> {
  if (!API_BASE) return null;
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
