import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { NestFactory } from '@nestjs/core';
import cookie from '@fastify/cookie';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pkg from 'pg';
import NodeVault from 'node-vault';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';
import { VaultService } from '../src/domains/identity/vault/vault.service.js';

const { Pool } = pkg;

const GITHUB_USER = { id: 12345, login: 'alice' };
const GITHUB_TOKEN = 'ghp_fake_github_access_token_1234567890abcdef';

// The two repos the picker lists; docker-compose-probe variants come from the
// auth flow (see mock below).
const REPO_DOCKERFILE = {
  id: 101,
  full_name: 'alice/app-docker',
  name: 'app-docker',
  clone_url: 'https://github.com/alice/app-docker.git',
  html_url: 'https://github.com/alice/app-docker',
  private: false,
  default_branch: 'main',
  updated_at: '2026-01-02T00:00:00Z',
};
const REPO_PLAIN = {
  id: 102,
  full_name: 'alice/app-plain',
  name: 'app-plain',
  clone_url: 'https://github.com/alice/app-plain.git',
  html_url: 'https://github.com/alice/app-plain',
  private: false,
  default_branch: 'main',
  updated_at: '2026-01-01T00:00:00Z',
};

function cookiesOf(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
}

// Component B gate: GET /repos returns the authenticated user's repos, and
// /repos/:id/deployable correctly flags a known-deployable repo true and a
// non-deployable one false — token sourced from A (decrypted via Vault), no repo
// bytes entering the plane (docs/control-plane.md §12 gate B). Real Postgres +
// real Vault via Testcontainers; GitHub is mocked (the one external call).
describe('Repos (B) — picker API against real Postgres + Vault', () => {
  let pg: PostgreSqlContainer;
  let vault: StartedTestContainer;
  let app: NestFastifyApplication;
  let vaultService: VaultService;
  const fetchSpy = vi.fn();

  beforeAll(async () => {
    // --- env required at boot (EnvService fail-fast) ---
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/auth/callback';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';

    // --- real Postgres ---
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    await migrate(drizzle(pool), {
      migrationsFolder: path.resolve(
        fileURLToPath(import.meta.url),
        '../../src/db/migrations',
      ),
    });
    await pool.end();

    // --- real Vault Transit ---
    vault = await new GenericContainer('hashicorp/vault:1.15')
      .withExposedPorts(8200)
      .withCommand(['server', '-dev', '-dev-root-token-id', 'root-token'])
      .start();
    const vaultEndpoint = `http://${vault.getHost()}:${vault.getMappedPort(8200)}`;
    process.env.VAULT_ADDR = vaultEndpoint;
    process.env.VAULT_TOKEN = 'root-token';
    const admin = NodeVault({ endpoint: vaultEndpoint, token: 'root-token' });
    await admin.mount({ mount_point: 'transit', type: 'transit' });
    await admin.transitCreateKey({ name: 'github-tokens' });

    // --- mock GitHub ---
    // Auth flow: POST /login/oauth/access_token → token; GET /user → profile.
    // Picker: GET /user/repos → the two repos above; each repo's contents
    // listing returns its root entries (entry names only, like the real API).
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === 'https://github.com/login/oauth/access_token') {
        return { ok: true, json: async () => ({ access_token: GITHUB_TOKEN }) };
      }
      if (url === 'https://api.github.com/user') {
        return { ok: true, json: async () => GITHUB_USER };
      }
      if (url === 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member') {
        return { ok: true, json: async () => [REPO_DOCKERFILE, REPO_PLAIN] };
      }
      if (url === 'https://api.github.com/repos/alice/app-docker/contents/') {
        return { ok: true, json: async () => [{ name: 'Dockerfile' }] };
      }
      if (url === 'https://api.github.com/repos/alice/app-plain/contents/') {
        return { ok: true, json: async () => [{ name: 'README.md' }] };
      }
      throw new Error(`Unexpected fetch URL: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
    );
    await app.register(cookie);
    await app.init();
    vaultService = app.get(VaultService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    await vault?.stop();
    vi.unstubAllGlobals();
  });

  async function newPool(): Promise<pkg.Pool> {
    return new Pool({ connectionString: pg.getConnectionUri() });
  }

  // OAuth round-trip → access JWT + stored ciphertext (shared by all cases).
  async function login(): Promise<string> {
    const start = await app.inject({ method: 'GET', url: '/auth/github' });
    const state = cookiesOf(start.headers as Record<string, unknown>).match(
      /gh_oauth_state=([^;]+)/,
    )?.[1];
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=fake-code&state=${state}`,
      headers: { cookie: `gh_oauth_state=${state}` },
    });
    return decodeURIComponent(
      (cb.headers.location as string).split('access_token=')[1],
    );
  }

  it('GET /repos returns the user repos, authed with the token decrypted from Vault', async () => {
    const accessToken = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/repos',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 101,
        fullName: 'alice/app-docker',
        name: 'app-docker',
        cloneUrl: 'https://github.com/alice/app-docker.git',
        htmlUrl: 'https://github.com/alice/app-docker',
        private: false,
        defaultBranch: 'main',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 102,
        fullName: 'alice/app-plain',
        name: 'app-plain',
        cloneUrl: 'https://github.com/alice/app-plain.git',
        htmlUrl: 'https://github.com/alice/app-plain',
        private: false,
        defaultBranch: 'main',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    // Token sourced from A: the Authorization header on the /user/repos call
    // carries exactly the plaintext that decrypts out of github_tokens.
    const repoCall = fetchSpy.mock.calls.find(
      ([url]) => url === 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    );
    expect(repoCall).toBeTruthy();
    const headers = (repoCall![1] as RequestInit).headers as Record<string, string>;
    const p = await newPool();
    const { rows } = await p.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM github_tokens',
    );
    await p.end();
    const decrypted = await vaultService.decrypt(rows[0].ciphertext);
    expect(headers['Authorization']).toBe(`Bearer ${decrypted}`);
  });

  it('flags a repo with a Dockerfile as deployable', async () => {
    const accessToken = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/repos/101/deployable',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      fullName: 'alice/app-docker',
      deployable: true,
    });
  });

  it('flags a repo with docker-compose.yml as deployable', async () => {
    // The picker's probe checks docker-compose.yml / compose.yaml / Dockerfile
    // (overview.md §2.1 ladder steps 1–2).
    const accessToken = await login();
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === 'https://github.com/login/oauth/access_token') {
        return { ok: true, json: async () => ({ access_token: GITHUB_TOKEN }) };
      }
      if (url === 'https://api.github.com/user') {
        return { ok: true, json: async () => GITHUB_USER };
      }
      if (url === 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member') {
        return { ok: true, json: async () => [REPO_DOCKERFILE, REPO_PLAIN] };
      }
      if (url === 'https://api.github.com/repos/alice/app-docker/contents/') {
        return { ok: true, json: async () => [{ name: 'docker-compose.yml' }] };
      }
      if (url === 'https://api.github.com/repos/alice/app-plain/contents/') {
        return { ok: true, json: async () => [{ name: 'README.md' }] };
      }
      throw new Error(`Unexpected fetch URL: ${method} ${url}`);
    });

    const res = await app.inject({
      method: 'GET',
      url: '/repos/101/deployable',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      fullName: 'alice/app-docker',
      deployable: true,
    });
  });

  it('flags a repo with neither file as NOT deployable', async () => {
    const accessToken = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/repos/102/deployable',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      fullName: 'alice/app-plain',
      deployable: false,
    });
  });

  it('404s an id that is not in the user\u2019s own repo list (ownership)', async () => {
    const accessToken = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/repos/999/deployable',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('fails closed: no or garbage bearer token → 401 on both routes', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/repos' });
    expect(noAuth.statusCode).toBe(401);
    const noAuthProbe = await app.inject({
      method: 'GET',
      url: '/repos/101/deployable',
    });
    expect(noAuthProbe.statusCode).toBe(401);

    const garbage = await app.inject({
      method: 'GET',
      url: '/repos',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(garbage.statusCode).toBe(401);
  });

  it('writes nothing: repo_cache stays empty (cache deliberately skipped)', async () => {
    const accessToken = await login();
    await app.inject({
      method: 'GET',
      url: '/repos',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await app.inject({
      method: 'GET',
      url: '/repos/101/deployable',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const pool = await newPool();
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM repo_cache',
    );
    await pool.end();
    expect(Number(rows[0].count)).toBe(0);
  });
});
