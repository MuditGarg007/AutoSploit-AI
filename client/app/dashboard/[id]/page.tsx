// Live engagement view. Server shell resolves the engagement label, then hands
// off to the client orchestrator that owns the SSE subscription. Repo name comes
// from the mock index until the control-plane metadata endpoint is wired; the
// stream itself falls back to the scripted demo when no API is configured.
// Rendered full-bleed: the cockpit owns the whole viewport and its own bar.
import DashboardShell from "@/components/dashboard/DashboardShell";
import LiveEngagement from "@/components/dashboard/LiveEngagement";
import { getEngagement } from "@/lib/api";

export default async function EngagementPage({
  params,
}: PageProps<"/dashboard/[id]">) {
  const { id } = await params;
  // Label only; the live event stream is owned client-side by LiveEngagement.
  // getEngagement falls back to the mock index when no backend is configured,
  // and an unknown id just shows the id itself.
  // Server-side we have no auth (the access token lives in the browser's
  // localStorage, and the server fetch carries no session cookie), so the
  // backend rejects this read and we fall back to the raw id. LiveEngagement
  // re-resolves the real repo name client-side, where the token exists.
  let repo = id;
  try {
    repo = (await getEngagement(id))?.repo ?? id;
  } catch {
    // Unauthenticated / unreachable server-side: the client resolves the label.
  }

  return (
    <DashboardShell fullBleed>
      <LiveEngagement id={id} repo={repo} />
    </DashboardShell>
  );
}
