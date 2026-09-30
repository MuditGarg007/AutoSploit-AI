// Live engagement view. Server shell resolves the engagement label, then hands
// off to the client orchestrator that owns the SSE subscription. Repo name comes
// from the mock index until the control-plane metadata endpoint is wired; the
// stream itself falls back to the scripted demo when no API is configured.
// Rendered inside the dashboard shell (sidebar + top bar).
import DashboardShell from "@/components/dashboard/DashboardShell";
import LiveEngagement from "@/components/dashboard/LiveEngagement";
import { findEngagement } from "@/lib/mock-engagements";

export default async function EngagementPage({
  params,
}: PageProps<"/dashboard/[id]">) {
  const { id } = await params;
  const repo = findEngagement(id)?.repo ?? id;

  return (
    <DashboardShell>
      <LiveEngagement id={id} repo={repo} />
    </DashboardShell>
  );
}
