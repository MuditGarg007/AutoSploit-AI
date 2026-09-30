"use client";

// Client orchestrator for one engagement's live view. Holds the single SSE
// subscription, derives the header state from the phase stream, and splits the
// detail into tabs so no one screen has to carry everything: an Overview glance,
// then the activity feed, findings, phases, and the immutable scope on their own
// panes. State that always matters (lifecycle, connection) rides in the header
// above the tabs; a halt is surfaced on every tab so it is never missed.

import { useState } from "react";
import Link from "next/link";
import { useEngagementStream } from "@/hooks/useEngagementStream";
import {
  isTerminal,
  severityRank,
  type EngagementState,
  type EngagementView,
} from "@/lib/events";
import { fmtElapsed, fmtUsd, fmtInt } from "@/lib/format";
import PageHeader from "./PageHeader";
import StatTiles, { type Stat } from "./StatTiles";
import Tabs, { type TabDef } from "./Tabs";
import PhaseTimeline from "./PhaseTimeline";
import ToolCallFeed from "./ToolCallFeed";
import FindingsTable from "./FindingsTable";
import CostMeter from "./CostMeter";
import ScopePanel from "./ScopePanel";
import HaltBanner from "./HaltBanner";
import StateLabel from "./StateLabel";
import ConnectionStatus from "./ConnectionStatus";
import Panel from "./Panel";
import { MetaRow } from "./MetaPanel";
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

// Order the severities that are actually present, most severe first, for the
// Overview breakdown. Buckets with no findings are dropped.
function severityCounts(view: EngagementView): { label: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const f of view.findings) {
    const key = f.severity.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([label, n]) => ({ label, n }));
}

type TabId = "overview" | "activity" | "findings" | "phases" | "scope";

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
  const [tab, setTab] = useState<TabId>("overview");

  const stage = view.currentStage as EngagementState | undefined;
  const done = Boolean(view.halt) || (stage ? isTerminal(stage) : false);
  const state = deriveState(view);

  const first = view.phases[0]?.ts;
  const last = view.phases[view.phases.length - 1]?.ts;
  const elapsed = first && last ? fmtElapsed(first, last) : "0:00";

  const latestPhase = view.phases[view.phases.length - 1];
  const sev = severityCounts(view);

  const stats: Stat[] = [
    {
      label: "Target",
      value: view.host ?? "pending",
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
    { label: "Spend", value: fmtUsd(view.cost?.usd ?? 0), icon: DollarIcon },
    {
      label: "Events",
      value: fmtInt(view.eventCount),
      hint: "stream total",
      icon: ActivityIcon,
    },
  ];

  const tabs: TabDef[] = [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity", count: view.tools.length },
    { id: "findings", label: "Findings", count: view.findings.length },
    { id: "phases", label: "Phases", count: view.phases.length },
    { id: "scope", label: "Scope" },
  ];

  const halted = view.halt || view.refusal;

  return (
    <>
      <PageHeader
        title={repo}
        titleMono
        crumbs={[{ label: "Engagements", href: "/dashboard" }, { label: repo }]}
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

      {/* A halt is a run-ending fact; keep it visible no matter the open tab. */}
      {halted && (
        <div className="mt-6">
          <HaltBanner halt={view.halt} refusal={view.refusal} />
        </div>
      )}

      <div className="mt-6">
        <Tabs
          tabs={tabs}
          active={tab}
          onChange={(id) => setTab(id as TabId)}
        />
      </div>

      <div className="mt-6">
        {tab === "overview" && (
          <div className="flex flex-col gap-6">
            <StatTiles stats={stats} />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
              <Panel title="Current phase" icon={ActivityIcon}>
                {latestPhase ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-base font-medium capitalize text-text">
                        {latestPhase.stage}
                      </span>
                      <StateLabel state={state} />
                    </div>
                    {latestPhase.summary && (
                      <p className="text-sm leading-relaxed text-muted">
                        {latestPhase.summary}
                      </p>
                    )}
                    {latestPhase.reasoning && (
                      <p className="text-xs leading-relaxed text-faint">
                        {latestPhase.reasoning}
                      </p>
                    )}
                    {(latestPhase.attempt !== undefined ||
                      latestPhase.nudges !== undefined) && (
                      <div className="mt-1 flex flex-col divide-y divide-white/5">
                        {latestPhase.attempt !== undefined && (
                          <MetaRow
                            label="Attempt"
                            value={fmtInt(latestPhase.attempt)}
                          />
                        )}
                        {latestPhase.nudges !== undefined && (
                          <MetaRow
                            label="Nudges"
                            value={fmtInt(latestPhase.nudges)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-faint">Awaiting first phase.</p>
                )}
              </Panel>

              <Panel title="Budget" icon={CoinsIcon}>
                <CostMeter cost={view.cost} />
              </Panel>
            </div>

            <Panel title="Findings by severity" icon={TargetIcon}>
              {sev.length === 0 ? (
                <p className="text-sm text-faint">No findings yet.</p>
              ) : (
                <div className="flex flex-wrap gap-x-10 gap-y-4">
                  {sev.map((s) => (
                    <div key={s.label} className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
                        {s.label}
                      </span>
                      <span className="font-mono text-xl tabular-nums text-text">
                        {fmtInt(s.n)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}

        {tab === "activity" && (
          <Panel
            title="Tool calls"
            icon={WrenchIcon}
            aside={
              <span className="font-mono text-xs text-faint">
                {view.tools.length}
              </span>
            }
          >
            <ToolCallFeed tools={view.tools} />
          </Panel>
        )}

        {tab === "findings" && (
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
        )}

        {tab === "phases" && (
          <Panel title="Phases" icon={ClockIcon}>
            <PhaseTimeline
              phases={view.phases}
              currentStage={view.currentStage}
            />
          </Panel>
        )}

        {tab === "scope" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
            <Panel title="Scope" icon={ShieldIcon}>
              <ScopePanel host={view.host} ports={view.ports} />
            </Panel>
            <Panel title="Budget" icon={CoinsIcon}>
              <CostMeter cost={view.cost} />
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
