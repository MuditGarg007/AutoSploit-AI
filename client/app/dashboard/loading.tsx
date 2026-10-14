import DashboardShell from "@/components/dashboard/DashboardShell";

// Shown while a dashboard route resolves. Keeps the shell so the top nav stays
// put; the content column holds a quiet placeholder.
export default function DashboardLoading() {
  return (
    <DashboardShell>
      <span className="font-mono text-xs uppercase tracking-widest text-faint">
        Loading
      </span>
    </DashboardShell>
  );
}
