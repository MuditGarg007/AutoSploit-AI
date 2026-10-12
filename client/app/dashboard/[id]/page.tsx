// Live engagement view. Server shell resolves the engagement label, then hands
// off to the client orchestrator that owns the SSE subscription. Repo name comes
// from the mock index until the control-plane metadata endpoint is wired; the
// stream itself falls back to the scripted demo when no API is configured.
// Rendered inside the dashboard shell (sidebar + top bar).
import DashboardShell from "@/components/dashboard/DashboardShell";
import LiveEngagement from "@/components/dashboard/LiveEngagement";
import { getEngagement, listEngagements } from "@/lib/api";

export default async function EngagementPage({
  params,
}: PageProps<"/dashboard/[id]">) {
  const { id } = await params;
  // Label only; the live event stream is owned client-side by LiveEngagement.
  // getEngagement falls back to the mock index when no backend is configured,
  // and an unknown id just shows the id itself.
  let repo = id;
  try {
    repo = (await getEngagement(id))?.repo ?? id;
  } catch {
    // Backend rejected (404/unauthorized): fall back to the raw id label.
  }
  // If the detail endpoint did not resolve a repo name (returned the id, or an
  // empty repoFullName), recover it from the list endpoint, which carries
  // repoFullName. Without this the header and breadcrumb show the raw UUID.
  if (!repo || repo === id) {
    try {
      const rows = await listEngagements();
      repo = rows.find((r) => r.id === id)?.repo || repo;
    } catch {
      // List unavailable: keep the id label.
    }
  }

  return (
    <DashboardShell>
      <LiveEngagement id={id} repo={repo} />
    </DashboardShell>
  );
}
