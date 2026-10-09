"use client";

// Subscribes to one engagement's live event stream and folds it into an
// EngagementView the panels render. Transport is SSE, GET /engagements/:id/stream
// on the control plane, which replays a bounded backlog then tails live
// (docs/control-plane.md §8.2). EventSource resumes with Last-Event-ID on its
// own, so a dropped socket picks up where it left off.
//
// When no API base is configured, or the socket cannot be reached, the hook
// falls back to the scripted mock so the dashboard is fully renderable in local
// dev without a running backend.

import { useEffect, useRef, useState } from "react";
import {
  emptyView,
  reduceEvent,
  type EngagementEvent,
  type EngagementEvent as Ev,
  type EngagementView,
} from "@/lib/events";
import { driveMockStream } from "@/lib/mock-stream";
import { getFreshToken, refreshToken } from "@/lib/token";

export type StreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "mock";

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

interface Options {
  // Force the mock source regardless of API config (used by the demo route).
  mock?: boolean;
}

export function useEngagementStream(
  engagementId: string,
  opts: Options = {},
): { view: EngagementView; status: StreamStatus } {
  const [view, setView] = useState<EngagementView>(emptyView);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  // Reducer runs against a ref so overlapping deliveries fold in order without
  // stale-closure races, then we publish the snapshot to state.
  const viewRef = useRef<EngagementView>(emptyView());

  useEffect(() => {
    viewRef.current = emptyView();
    setView(viewRef.current);

    const push = (ev: EngagementEvent) => {
      viewRef.current = reduceEvent(viewRef.current, ev);
      setView(viewRef.current);
    };

    // Mock path: explicit opt-in, or no API base to connect to.
    if (opts.mock || !API_BASE) {
      setStatus("mock");
      const handle = driveMockStream(push);
      return () => handle.cancel();
    }

    // Live path. The access token is short-lived (15 min); EventSource cannot
    // set an Authorization header and does not retry an HTTP error (a 401 on an
    // expired token drives it straight to CLOSED with no reconnect), so we
    // manage the token and reconnect ourselves:
    //  - connect with a proactively-refreshed token (query param — the
    //    SessionGuard accepts it on the stream route only);
    //  - let native EventSource auto-reconnect handle transient network drops
    //    (it resends the Last-Event-ID header on its own);
    //  - on a hard CLOSE (the auth-expiry signature), refresh the token and
    //    rebuild the EventSource, resuming from the last event id via a query
    //    param since the rebuilt socket's first request carries no header.
    setStatus("connecting");

    let es: EventSource | null = null;
    let cancelled = false;
    let reconnecting = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = (token: string | null) => {
      if (cancelled) return;
      const params = new URLSearchParams();
      if (token) params.set("access_token", token);
      // Resume exactly after the last event we folded in, so a reconnect never
      // replays already-seen phases / tool calls (reduceEvent is not idempotent
      // for those). Empty cursor on first connect → server replays the backlog.
      const cursor = viewRef.current.lastEventId;
      if (cursor) params.set("last_event_id", cursor);
      const qs = params.toString();
      es = new EventSource(
        `${API_BASE}/engagements/${encodeURIComponent(engagementId)}/stream` +
          (qs ? `?${qs}` : ""),
        { withCredentials: true },
      );

      es.onopen = () => {
        if (!cancelled) setStatus("live");
      };

      es.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data) as Omit<Ev, "id">;
          push({ ...parsed, id: msg.lastEventId } as EngagementEvent);
        } catch {
          // Ignore keep-alive comments / malformed frames.
        }
      };

      es.onerror = () => {
        if (cancelled || !es) return;
        if (es.readyState !== EventSource.CLOSED) {
          // Transient drop: native EventSource is already reconnecting with the
          // Last-Event-ID header and the current (still-valid) token.
          setStatus("reconnecting");
          return;
        }
        // Hard close: almost always an expired token (EventSource will not retry
        // an HTTP error). Refresh and rebuild once; a failed refresh means the
        // session is truly gone, so stay closed.
        es.close();
        es = null;
        if (reconnecting) return;
        reconnecting = true;
        setStatus("reconnecting");
        void refreshToken().then((token) => {
          reconnecting = false;
          if (cancelled) return;
          if (!token) {
            setStatus("closed");
            return;
          }
          reconnectTimer = setTimeout(() => open(token), 500);
        });
      };
    };

    void getFreshToken().then((token) => {
      if (cancelled) return;
      open(token);
    });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [engagementId, opts.mock]);

  return { view, status };
}
