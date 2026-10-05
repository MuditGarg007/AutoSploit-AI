// Mock repo list for the new-engagement picker without a control plane. Shapes
// mirror what GET /repos returns (control-plane repos.service GitHubRepo: id,
// fullName, name), plus the deployable flag that GET /repos/:id/deployable
// resolves separately. The picker renders these until NEXT_PUBLIC_API_URL is set.

export interface Repo {
  id: number;
  fullName: string;
  name: string;
  // Resolved by the deployable probe (GET /repos/:id/deployable). On mock it is
  // baked in; live, the form probes it when a repo is selected.
  deployable?: boolean;
}

export const MOCK_REPOS: Repo[] = [
  { id: 101, fullName: "acme/storefront", name: "storefront", deployable: true },
  { id: 102, fullName: "acme/billing-api", name: "billing-api", deployable: true },
  { id: 103, fullName: "acme/internal-tools", name: "internal-tools", deployable: true },
  { id: 104, fullName: "acme/marketing-site", name: "marketing-site", deployable: false },
  { id: 105, fullName: "acme/docs", name: "docs", deployable: false },
];

export function findRepo(id: number): Repo | undefined {
  return MOCK_REPOS.find((r) => r.id === id);
}
