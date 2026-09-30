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

    // Live path.
    setStatus("connecting");
    const url = `${API_BASE}/engagements/${encodeURIComponent(
      engagementId,
    )}/stream`;
    const es = new EventSource(url, { withCredentials: true });

    es.onopen = () => setStatus("live");

    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as Omit<Ev, "id">;
        push({ ...parsed, id: msg.lastEventId } as EngagementEvent);
      } catch {
        // Ignore keep-alive comments / malformed frames.
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects with Last-Event-ID; reflect the gap.
      setStatus(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    };

    return () => es.close();
  }, [engagementId, opts.mock]);

  return { view, status };
}
