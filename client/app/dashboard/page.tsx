// Engagements index. Where Clerk lands a user after sign in. An overview strip,
// then the run table; each row opens the live view. Reads mock rows until the
// control-plane list endpoint is wired. Rendered inside the dashboard shell
// (sidebar + top bar), not the marketing navbar.
import Link from "next/link";
import DashboardShell from "@/components/dashboard/DashboardShell";
import PageHeader from "@/components/dashboard/PageHeader";
import StatTiles, { type Stat } from "@/components/dashboard/StatTiles";
import Panel from "@/components/dashboard/Panel";
import EngagementList from "@/components/dashboard/EngagementList";
import {
  PlusIcon,
  GridIcon,
  ActivityIcon,
  TargetIcon,
  DollarIcon,
  HaltIcon,
} from "@/components/dashboard/icons";
import type { EngagementRow } from "@/lib/mock-engagements";
import { listEngagements } from "@/lib/api";
import { isTerminal } from "@/lib/events";
import { fmtUsd, fmtInt } from "@/lib/format";

function summarize(rows: EngagementRow[]): Stat[] {
  const active = rows.filter((e) => !isTerminal(e.state)).length;
  const stopped = rows.filter(
    (e) => e.state === "halted" || e.state === "failed",
  ).length;
  const findings = rows.reduce((n, e) => n + e.findings, 0);
  const spend = rows.reduce((n, e) => n + e.usd, 0);
  return [
    { label: "Engagements", value: fmtInt(rows.length), icon: GridIcon },
    {
      label: "Active",
      value: fmtInt(active),
      hint: "running now",
      icon: ActivityIcon,
    },
    {
      label: "Findings",
      value: fmtInt(findings),
      hint: "all runs",
      icon: TargetIcon,
    },
    { label: "Spend", value: fmtUsd(spend), hint: "all runs", icon: DollarIcon },
    {
      label: "Stopped",
      value: fmtInt(stopped),
      hint: "halted / failed",
      accent: stopped > 0,
      icon: HaltIcon,
    },
  ];
}

export default async function DashboardPage() {
  const rows = await listEngagements();
  return (
    <DashboardShell>
      <PageHeader
        title="Engagements"
        subtitle="Isolated red-team runs. Select one to watch it live."
        actions={
          <Link
            href="/dashboard/new"
            className="flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
          >
            <PlusIcon size={15} />
            New engagement
          </Link>
        }
      />

      <div className="mt-6">
        <StatTiles stats={summarize(rows)} />
      </div>

      <div className="mt-8">
        <Panel
          title="All runs"
          flush
          aside={
            <span className="font-mono text-xs text-faint">{rows.length}</span>
          }
        >
          <EngagementList rows={rows} />
        </Panel>
      </div>
    </DashboardShell>
  );
}
