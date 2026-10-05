// New engagement. A repo picker plus a submit: the dispatch contract is POST
// /engagements with body { repoId } only, so there are no scope or spend/token
// cap inputs (those are server-side operator config). Rendered in the dashboard
// shell. The interactive picker lives in a client component; this page is just the
// header + frame.
import DashboardShell from "@/components/dashboard/DashboardShell";
import PageHeader from "@/components/dashboard/PageHeader";
import NewEngagementForm from "@/components/dashboard/NewEngagementForm";

export default function NewEngagementPage() {
  return (
    <DashboardShell>
      <PageHeader
        title="New engagement"
        subtitle="Pick a repository to deploy and attack in isolation."
        crumbs={[
          { label: "Engagements", href: "/dashboard" },
          { label: "New" },
        ]}
      />
      <NewEngagementForm />
    </DashboardShell>
  );
}
