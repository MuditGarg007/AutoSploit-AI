"use client";

// React surface for the GitHub-OAuth session. The isomorphic primitives live in
// lib/token.ts; this adds the useAuth hook the UI binds to. With no backend
// configured (NEXT_PUBLIC_API_URL unset) it reports a synthetic signed-in user
// so the mock demo renders, matching the fallback in lib/api.ts.

import { useCallback, useEffect, useState } from "react";
import {
  captureTokenFromUrl,
  clearToken,
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
 * Owns the browser session. On mount: capture any token from the OAuth redirect,
 * then load the signed-in user from GET /me (refreshing once on a 401). `signOut`
 * revokes the server session and returns the user to the marketing root.
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
    let alive = true;

    if (!hasBackend()) return;

    captureTokenFromUrl();

    const loadMe = async (retry: boolean): Promise<void> => {
      const token = getToken();
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
          clearToken();
          if (alive) {
            setUser(null);
            setStatus("signed-out");
          }
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
