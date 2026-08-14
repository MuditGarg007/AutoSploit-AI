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

// fastify inject returns set-cookie as an array when multiple cookies are set;
// join them so the assertions below read them as one string.
function cookiesOf(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
}

// Component A gate: a fresh user completes the OAuth round-trip; /me returns
// their identity from a valid session; their GitHub token is persisted as
// CIPHERTEXT (plaintext never lands in Postgres or logs) and decryptable only
// through Vault (docs/control-plane.md §12 gate A). Real Postgres + real Vault
// via Testcontainers — only GitHub is mocked (the one external call CI can't
// reach) via a fetch stub at the callback.
describe('Identity (A) — OAuth round-trip against real Postgres + Vault', () => {
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

    // --- mock GitHub (the one external call; CI can't hit GitHub) ---
    // POST /login/oauth/access_token → token; GET /user → profile.
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return { ok: true, json: async () => ({ access_token: GITHUB_TOKEN }) };
      }
      if (url === 'https://api.github.com/user') {
        return { ok: true, json: async () => GITHUB_USER };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
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

  it('completes the OAuth round-trip: callback → refresh cookie + access JWT', async () => {
    // Start like a real client: hit /auth/github first to get the state cookie.
    const start = await app.inject({ method: 'GET', url: '/auth/github' });
    expect(start.statusCode).toBe(302);
    const location = start.headers.location as string;
    expect(location).toContain('https://github.com/login/oauth/authorize?');

    const setCookie = cookiesOf(start.headers as Record<string, unknown>);
    const state = setCookie.match(/gh_oauth_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();

    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=fake-code&state=${state}`,
      headers: { cookie: `gh_oauth_state=${state}` },
    });

    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain('access_token=');
    const cbCookies = cookiesOf(cb.headers as Record<string, unknown>);
    expect(cbCookies).toContain('refresh_token=');
    expect(cbCookies).toContain('HttpOnly');
    expect(cbCookies).toContain('SameSite=Lax');
  });

  it('GET /me returns the user identity from the valid session', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/github' });
    const state = cookiesOf(start.headers as Record<string, unknown>).match(
      /gh_oauth_state=([^;]+)/,
    )?.[1];
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=fake-code&state=${state}`,
      headers: { cookie: `gh_oauth_state=${state}` },
    });
    const accessToken = decodeURIComponent(
      (cb.headers.location as string).split('access_token=')[1],
    );

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: expect.any(String),
      githubId: '12345',
      login: 'alice',
    });
  });

  it('persists the GitHub token as ciphertext only — plaintext never in DB or response', async () => {
    // Do a fresh login, then inspect github_tokens in the real Postgres.
    const start = await app.inject({ method: 'GET', url: '/auth/github' });
    const state = cookiesOf(start.headers as Record<string, unknown>).match(
      /gh_oauth_state=([^;]+)/,
    )?.[1];
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=fake-code&state=${state}`,
      headers: { cookie: `gh_oauth_state=${state}` },
    });

    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM github_tokens',
    );
    await pool.end();

    expect(rows.length).toBe(1);
    const ciphertext = rows[0].ciphertext;
    expect(ciphertext.startsWith('vault:v1:')).toBe(true);
    expect(ciphertext).not.toContain(GITHUB_TOKEN);
    expect(ciphertext).not.toContain(Buffer.from(GITHUB_TOKEN).toString('base64'));

    // The plaintext never appears in the callback's location header either
    // (the only thing a 302 redirect carries).
    expect(String(cb.headers.location)).not.toContain(GITHUB_TOKEN);
  });

  it('decrypts the stored ciphertext back to the GitHub token ONLY through Vault', async () => {
    const pool = new Pool({ connectionString: pg.getConnectionUri() });
    const { rows } = await pool.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM github_tokens',
    );
    await pool.end();

    const decrypted = await vaultService.decrypt(rows[0].ciphertext);
    expect(decrypted).toBe(GITHUB_TOKEN);
  });

  it('fails closed: /me rejects a missing or garbage token (401)', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/me' });
    expect(noAuth.statusCode).toBe(401);

    const garbage = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(garbage.statusCode).toBe(401);
  });
});
