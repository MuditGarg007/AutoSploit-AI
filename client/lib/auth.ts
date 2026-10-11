"use client";

// React surface for the GitHub-OAuth session. The isomorphic primitives live in
// lib/token.ts; this adds the useAuth hook the UI binds to. With no backend
// configured (NEXT_PUBLIC_API_URL unset) it reports a synthetic signed-in user
// so the mock demo renders, matching the fallback in lib/api.ts.

import { useCallback, useEffect, useState } from "react";
import {
  accessTokenExpiryMs,
  clearToken,
  getFreshToken,
  getToken,
  hasBackend,
  refreshToken,
  signOutRequest,
} from "./token";

export { hasBackend, signInUrl } from "./token";

export interface AuthUser {
  id: string;
  githubLogin: string;
  avatarUrl?: string;
}

export type AuthStatus = "loading" | "signed-in" | "signed-out";

// Wire shape of GET /me (identity.controller). Only display fields are read.
interface MeResponse {
  id: string;
  githubLogin?: string;
  login?: string;
  avatarUrl?: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
const MOCK_USER: AuthUser = { id: "mock", githubLogin: "demo" };

/**
 * Owns the browser session. On mount: mint an access token from the httpOnly
 * refresh cookie if none is held yet (the OAuth callback redirects here with no
 * token on the URL), load the signed-in user from GET /me (refreshing once on a
 * 401), then run a proactive timer that re-mints the access token ~60s before it
 * expires — so a sitting-idle dashboard stays signed in instead of silently
 * dying and only noticing on the next request. `signOut` revokes the server
 * session and returns the user to the marketing root.
 */
export function useAuth(): {
  user: AuthUser | null;
  status: AuthStatus;
  signOut: () => Promise<void>;
} {
  // Seed from the env-stable backend flag so the mock/demo build needs no effect
  // setState (which would trip react-hooks/set-state-in-effect).
  const [user, setUser] = useState<AuthUser | null>(() =>
    hasBackend() ? null : MOCK_USER,
  );
  const [status, setStatus] = useState<AuthStatus>(() =>
    hasBackend() ? "loading" : "signed-in",
  );

  useEffect(() => {
    if (!hasBackend()) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const signedOut = () => {
      clearToken();
      if (alive) {
        setUser(null);
        setStatus("signed-out");
      }
    };

    // Re-mint the access token ~60s before it expires, then reschedule off the
    // new token. A failed refresh means the session is truly gone → sign out.
    const scheduleRefresh = (token: string | null): void => {
      if (timer) clearTimeout(timer);
      const expMs = accessTokenExpiryMs(token);
      const LEAD_MS = 60_000;
      // Unknown expiry: re-check in a minute rather than hammering.
      const delay = expMs
        ? Math.max(5_000, expMs - Date.now() - LEAD_MS)
        : 60_000;
      timer = setTimeout(() => {
        void refreshToken().then((next) => {
          if (!alive) return;
          if (next) scheduleRefresh(next);
          else signedOut();
        });
      }, delay);
    };

    const loadMe = async (retry: boolean): Promise<void> => {
      // Mint from the refresh cookie when no token is held (first load after the
      // OAuth redirect lands here with none).
      const token = await getFreshToken();
      if (!token) {
        if (alive) {
          setUser(null);
          setStatus("signed-out");
        }
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/me`, {
          credentials: "include",
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
        if (res.status === 401 && retry) {
          const next = await refreshToken();
          if (next) return loadMe(false);
        }
        if (!res.ok) {
          signedOut();
          return;
        }
        const me = (await res.json()) as MeResponse;
        if (alive) {
          setUser({
            id: me.id,
            githubLogin: me.githubLogin ?? me.login ?? "account",
            avatarUrl: me.avatarUrl,
          });
          setStatus("signed-in");
          scheduleRefresh(getToken());
        }
      } catch {
        if (alive) {
          setUser(null);
          setStatus("signed-out");
        }
      }
    };

    void loadMe(true);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const doSignOut = useCallback(async () => {
    await signOutRequest();
    setUser(null);
    setStatus("signed-out");
    if (typeof window !== "undefined") window.location.href = "/";
  }, []);

  return { user, status, signOut: doSignOut };
}
