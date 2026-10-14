"use client";

// Client orchestrator for one engagement's live view, laid out as a cockpit: a
// single screen that updates in place, no tabs to hunt through. A lifecycle
// strip and the vital stats sit up top; the left column is the live activity
// console (the agent working, in its own words and commands); the right column
// holds the attack surface and the budget. Findings and the immutable scope run
// full-width below, so the detail the old tabs carried is all still here, just
// visible at once. A halt is a run-ending fact, pinned above everything.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useEngagementStream } from "@/hooks/useEngagementStream";
import { listEngagements } from "@/lib/api";
import {
  isTerminal,
  type EngagementState,
  type EngagementView,
} from "@/lib/events";
import { fmtElapsed, fmtUsd, fmtInt, fmtHost } from "@/lib/format";
import PageHeader from "./PageHeader";
import StatTiles, { type Stat } from "./StatTiles";
import PhaseStrip from "./PhaseStrip";
import ActivityStream from "./ActivityStream";
import SurfaceMap from "./SurfaceMap";
import FindingsTable from "./FindingsTable";
import CostMeter from "./CostMeter";
import ScopePanel from "./ScopePanel";
import HaltBanner from "./HaltBanner";
import StateLabel from "./StateLabel";
import ConnectionStatus from "./ConnectionStatus";
import Panel from "./Panel";
import {
  TargetIcon,
  ClockIcon,
  ShieldIcon,
  DollarIcon,
  ActivityIcon,
  CoinsIcon,
  WrenchIcon,
} from "./icons";

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

  const stats: Stat[] = [
    {
      label: "Target",
      value: fmtHost(view.host),
      hint: "deployed host",
      icon: ShieldIcon,
    },
    {
      label: "Elapsed",
      value: elapsed,
      hint: "since first phase",
      icon: ClockIcon,
    },
    { label: "Findings", value: fmtInt(view.findings.length), icon: TargetIcon },
    { label: "Spend", value: fmtUsd(usd), icon: DollarIcon },
    {
      label: "Tool calls",
      value: fmtInt(view.tools.length),
      hint: "actions run",
      icon: WrenchIcon,
    },
  ];

  const halted = view.halt || view.refusal;

  return (
    <>
      <PageHeader
        title={label}
        titleMono
        crumbs={[{ label: "Engagements", href: "/dashboard" }, { label }]}
        actions={
          <div className="flex items-center gap-5">
            <StateLabel state={state} />
            <ConnectionStatus status={status} />
            {done && (
              <Link
                href={`/dashboard/${id}/report`}
                className="flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
              >
                View report
              </Link>
            )}
          </div>
        }
      />

      {halted && (
        <div className="mt-6">
          <HaltBanner halt={view.halt} refusal={view.refusal} />
        </div>
      )}

      <div className="mt-6">
        <PhaseStrip state={state} />
      </div>

      <div className="mt-6">
        <StatTiles stats={stats} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel
          title="Live activity"
          icon={ActivityIcon}
          flush
          bodyClassName="py-2"
          aside={<ConnectionStatus status={status} />}
        >
          <ActivityStream view={view} />
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel title="Attack surface" icon={ShieldIcon}>
            <SurfaceMap
              host={view.host}
              ports={view.ports}
              findings={view.findings}
            />
          </Panel>

          <Panel title="Budget" icon={CoinsIcon}>
            <div className="flex flex-col gap-5">
              <CostMeter cost={view.cost} />
              {ratePerMin > 0 && (
                <div className="flex items-center justify-between border-t border-white/10 pt-4 text-xs">
                  <span className="text-faint">
                    Burn <span className="font-mono text-muted">{fmtUsd(ratePerMin)}/min</span>
                  </span>
                  {etaSec !== undefined && (
                    <span className="text-faint">
                      Runway{" "}
                      <span className="font-mono text-muted">
                        ~{fmtDur(etaSec)}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel
          title="Findings"
          icon={TargetIcon}
          flush
          aside={
            <span className="font-mono text-xs text-faint">
              {view.findings.length}
            </span>
          }
        >
          <FindingsTable findings={view.findings} />
        </Panel>

        <Panel title="Scope" icon={ShieldIcon}>
          <ScopePanel host={view.host} ports={view.ports} />
        </Panel>
      </div>
    </>
  );
}
