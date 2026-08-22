import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityService } from '../identity/identity.service.js';

const GITHUB_API = 'https://api.github.com';
const DEPLOYABLE_ROOT_FILES = [
  'docker-compose.yml',
  'compose.yaml',
  'Dockerfile',
];

// Shape of the GitHub REST /user/repos response we map (docs/control-plane.md §4.B).
export interface GitHubRepo {
  id: number;
  fullName: string;
  name: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface DeployableResult {
  fullName: string;
  deployable: boolean;
}

// Read-through proxy to the GitHub REST API (docs/control-plane.md §4.B). Uses
// A's token via IdentityService — never queries github_tokens itself (§5 rule 1).
// Holds no authoritative state and writes nothing (repo_cache deliberately unused
// for now); only repo metadata and root-directory entry NAMES cross this slice —
// no repo bytes enter the plane (§12 gate B).
@Injectable()
export class ReposService {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  async listRepos(userId: string): Promise<GitHubRepo[]> {
    const token = await this.requireToken(userId);
    const res = await this.githubFetch(
      `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
      token,
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    return body.map(this.toGitHubRepo);
  }

  // The deployable probe — presence of docker-compose.yml / compose.yaml /
  // Dockerfile at the repo root (overview.md §2.1 ladder steps 1–2). The :id is
  // matched against the user's own repo list, so an id outside it is a 404
  // (ownership, not existence). Probes the contents listing only — entry names,
  // never file bytes.
  async probeDeployable(
    userId: string,
    repoId: number,
  ): Promise<DeployableResult> {
    const repo = (await this.listRepos(userId)).find((r) => r.id === repoId);
    if (!repo) {
      throw new NotFoundException('Repo not found for this user');
    }

    const token = await this.requireToken(userId);
    const res = await this.githubFetch(
      `/repos/${repo.fullName}/contents/`,
      token,
    );
    const body = (await res.json()) as Array<{ name?: string }>;
    const rootNames = new Set(body.map((entry) => entry.name));
    const deployable = DEPLOYABLE_ROOT_FILES.some((f) => rootNames.has(f));
    return { fullName: repo.fullName, deployable };
  }

  // Returns the user's decrypted GitHub token via A's boundary. Missing token →
  // 401: a logged-in user with no linked token cannot list repos (fail-closed).
  private async requireToken(userId: string): Promise<string> {
    const token = await this.identity.getGithubToken(userId);
    if (!token) throw new UnauthorizedException('No GitHub token linked');
    return token;
  }

  // One authenticated fetch against the GitHub REST API. Fail-closed mapping:
  // 401/403 → unauthorized (token expired/revoked), 5xx → bad gateway, and
  // anything unexpected throws a 502 rather than leaking the raw body.
  private async githubFetch(
    path: string,
    token: string,
  ): Promise<Response> {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'autosploit-control-plane',
      },
    });
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) {
      throw new UnauthorizedException('GitHub token rejected');
    }
    throw new BadGatewayException(`GitHub API error (${res.status})`);
  }

  private toGitHubRepo(raw: Record<string, unknown>): GitHubRepo {
    return {
      id: Number(raw.id),
      fullName: String(raw.full_name),
      name: String(raw.name),
      cloneUrl: String(raw.clone_url),
      htmlUrl: String(raw.html_url),
      private: Boolean(raw.private),
      defaultBranch: String(raw.default_branch),
      updatedAt: String(raw.updated_at),
    };
  }
}
