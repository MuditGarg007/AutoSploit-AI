"use client";

// Client orchestrator for one engagement's live view, laid out as a true
// cockpit: the live activity console *is* the page, filling the viewport, and
// the quieter read-outs float over it as glass panels (budget + findings on the
// left, attack surface + scope on the right). The old left sidebar is gone, so
// this view carries its own bar: brand + a back link to the index on the left,
// then the repo, lifecycle state, elapsed and connection, with the report and
// new-engagement actions on the right. A halt is a run-ending fact, pinned above
// everything. Below xl the floating overlay would smother the transcript, so it
// falls back to the console over a stacked panel grid.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useEngagementStream } from "@/hooks/useEngagementStream";
import { listEngagements } from "@/lib/api";
import {
  isTerminal,
  type EngagementState,
  type EngagementView,
} from "@/lib/events";
import { fmtElapsed, fmtUsd } from "@/lib/format";
import PhaseStrip from "./PhaseStrip";
import ActivityStream from "./ActivityStream";
import SurfaceMap from "./SurfaceMap";
import FindingsTable from "./FindingsTable";
import CostMeter from "./CostMeter";
import ScopePanel from "./ScopePanel";
import HaltBanner from "./HaltBanner";
import StateLabel from "./StateLabel";
import ConnectionStatus from "./ConnectionStatus";
import ThemeToggle from "@/components/ThemeToggle";
import UserMenu from "./UserMenu";
import { ClockIcon, ArrowLeftIcon } from "./icons";

// A rail entry in the cockpit: a quiet mono label over its content, no border,
// no fill, no card. The side rails must stay out of the way so the live feed
// holds the eye; the chrome-less sections read as a margin annotation, not a
// competing panel.
function RailSection({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
          {label}
        </span>
        {aside}
      </div>
      {children}
    </section>
  );
}

// Map the latest phase stage onto a lifecycle state for the header label. The
// live view has no separate lifecycle socket yet; the index reads the
// authoritative state from the control plane.
function deriveState(view: EngagementView): EngagementState {
  if (view.halt) return "halted";
  const stage = view.currentStage as EngagementState | undefined;
  const known: EngagementState[] = [
    "provisioning",
    "deploying",
    "attacking",
    "completed",
    "halted",
    "failed",
  ];
  if (stage && known.includes(stage)) return stage;
  return "queued";
}

// Latest timestamp seen on any stream slice, for elapsed and burn rate.
function lastTs(view: EngagementView): string | undefined {
  const cands = [
    view.phases[view.phases.length - 1]?.ts,
    view.tools[view.tools.length - 1]?.ts,
    view.findings[view.findings.length - 1]?.ts,
  ].filter((t): t is string => Boolean(t));
  if (cands.length === 0) return undefined;
  return cands.reduce((a, b) => (new Date(a) > new Date(b) ? a : b));
}

function fmtDur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "n/a";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function LiveEngagement({
  id,
  repo,
  mock,
}: {
  id: string;
  repo: string;
  mock?: boolean;
}) {
  const { view, status } = useEngagementStream(id, { mock });

  // The server shell could not authenticate, so `repo` arrives as the raw id.
  // Re-resolve the real "owner/name" label client-side (the access token lives
  // in the browser), the same source the sidebar uses.
  const [resolved, setResolved] = useState<{ id: string; repo: string } | null>(
    null,
  );
  const label =
    repo !== id ? repo : resolved?.id === id ? resolved.repo : repo;
  useEffect(() => {
    if (repo !== id) return;
    let alive = true;
    listEngagements()
      .then((rows) => {
        const name = rows.find((r) => r.id === id)?.repo;
        if (alive && name) setResolved({ id, repo: name });
      })
      .catch(() => {
        /* keep the id label on a transient failure */
      });
    return () => {
      alive = false;
    };
  }, [id, repo]);

  const stage = view.currentStage as EngagementState | undefined;
  const done = Boolean(view.halt) || (stage ? isTerminal(stage) : false);
  const state = deriveState(view);

  const first = view.phases[0]?.ts;
  const last = lastTs(view);
  const elapsed = first && last ? fmtElapsed(first, last) : "0:00";

  // Burn rate over elapsed wall time, and a rough runway to the spend cap.
  const usd = view.cost?.usd ?? 0;
  const capUsd = view.cost?.caps?.usd;
  const elapsedSec =
    first && last
      ? Math.max(0, (new Date(last).getTime() - new Date(first).getTime()) / 1000)
      : 0;
  const ratePerMin = elapsedSec > 0 ? (usd / elapsedSec) * 60 : 0;
  const etaSec =
    !done && capUsd && ratePerMin > 0
      ? ((capUsd - usd) / ratePerMin) * 60
      : undefined;

  const halted = view.halt || view.refusal;

  // One quiet row. Navigation (back to the index) on the far left, then the
  // engagement's identity, with the few live read-outs and the session controls
  // pushed to the right. Deliberately sparse: the progress bar moved to the
  // bottom and the panels moved into the margins, so the top no longer competes
  // with the feed for attention.
  const bar = (
    <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
      <Link
        href="/dashboard"
        aria-label="Back to engagements"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-text"
      >
        <ArrowLeftIcon size={17} />
      </Link>

      <span
        className="min-w-0 truncate font-mono text-sm text-text"
        title={label}
      >
        {label}
      </span>
      <StateLabel state={state} className="shrink-0" />

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <span
          className="hidden items-center gap-1.5 font-mono text-xs tabular-nums text-faint sm:flex"
          title="Elapsed since first phase"
        >
          <ClockIcon size={13} />
          {elapsed}
        </span>
        <ConnectionStatus status={status} />
        {done && (
          <Link
            href={`/dashboard/${id}/report`}
            className="flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
          >
            View report
          </Link>
        )}
        <span className="hidden h-5 w-px bg-white/10 sm:block" />
        <ThemeToggle />
        <UserMenu />
      </div>
    </div>
  );

  // Budget read-out: the meter, then a one-line burn/runway note (no heavy
  // divider), kept lean for the rail.
  const budgetBody = (
    <div className="flex flex-col gap-4">
      <CostMeter cost={view.cost} />
      {ratePerMin > 0 && (
        <p className="text-xs text-faint">
          Burn{" "}
          <span className="font-mono text-muted">{fmtUsd(ratePerMin)}/min</span>
          {etaSec !== undefined && (
            <>
              , runway{" "}
              <span className="font-mono text-muted">~{fmtDur(etaSec)}</span>
            </>
          )}
        </p>
      )}
    </div>
  );

  // The two rail stacks, chrome-less (RailSection). Budget + findings sit left,
  // attack surface + scope sit right. Shared by the floating cockpit and the
  // stacked small-screen layout.
  const leftRail = (
    <>
      <RailSection label="Budget">{budgetBody}</RailSection>
      <RailSection
        label="Findings"
        aside={
          <span className="font-mono text-[10px] text-faint">
            {view.findings.length}
          </span>
        }
      >
        <FindingsTable findings={view.findings} bare />
      </RailSection>
    </>
  );

  const rightRail = (
    <>
      <RailSection label="Attack surface">
        <SurfaceMap ports={view.ports} findings={view.findings} />
      </RailSection>
      <RailSection label="Scope">
        <ScopePanel host={view.host} ports={view.ports} />
      </RailSection>
    </>
  );

  return (
    <>
      {/* xl cockpit: fixed-viewport, console fills, lean rails in the margins,
          progress pinned to the bottom. */}
      <div className="hidden h-screen flex-col overflow-hidden bg-canvas xl:flex">
        <header className="shrink-0 border-b border-white/10 bg-canvas/95 backdrop-blur-[2px]">
          {bar}
        </header>

        <div className="relative min-h-0 flex-1">
          <ActivityStream view={view} fill />

          {halted && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-4">
              <div className="pointer-events-auto w-full max-w-2xl">
                <HaltBanner halt={view.halt} refusal={view.refusal} />
              </div>
            </div>
          )}

          <div className="pointer-events-none absolute inset-0 z-10">
            <div className="pointer-events-auto absolute bottom-6 left-6 top-6 flex w-60 flex-col gap-7 overflow-y-auto pr-2">
              {leftRail}
            </div>
            <div className="pointer-events-auto absolute bottom-6 right-6 top-6 flex w-60 flex-col gap-7 overflow-y-auto pl-2">
              {rightRail}
            </div>
          </div>
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-canvas/95 px-6 py-2.5 backdrop-blur-[2px]">
          <PhaseStrip state={state} />
        </footer>
      </div>

      {/* below xl: the console over a stacked rail, normal page scroll, progress
          pinned to the bottom. */}
      <div className="flex min-h-screen flex-col bg-canvas xl:hidden">
        <header className="sticky top-0 z-30 shrink-0 border-b border-white/10 bg-canvas/95 backdrop-blur-[2px]">
          {bar}
        </header>
        <div className="flex-1 px-4 py-5 sm:px-6">
          {halted && (
            <div className="mb-4">
              <HaltBanner halt={view.halt} refusal={view.refusal} />
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-white/10 bg-surface py-2">
            <ActivityStream view={view} />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-7 sm:grid-cols-2">
            {leftRail}
            {rightRail}
          </div>
        </div>
        <footer className="sticky bottom-0 z-30 border-t border-white/10 bg-canvas/95 px-4 py-2.5 backdrop-blur-[2px] sm:px-6">
          <PhaseStrip state={state} />
        </footer>
      </div>
    </>
  );
}
