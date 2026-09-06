import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
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
import { Client as MinioClient } from 'minio';
import { decodeJwt } from 'jose';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';

const { Pool } = pkg;

const GITHUB_USER = { id: 12345, login: 'alice' };
const GITHUB_TOKEN = 'ghp_fake_github_access_token_1234567890abcdef';

function cookiesOf(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
}

// Component E gate (docs/control-plane.md §12): on an engagement reaching a
// terminal state, GET /:id/report serves the assembled report to its OWNER and
// every artifact downloads via a working presigned URL — with no write-back into
// D's tables. Real Postgres + Vault + MinIO via Testcontainers; GitHub is mocked.
// Engagements + findings are seeded directly (the conductor/worker are C's path,
// not E's) so this spec exercises only the read/assemble/presign path.
describe('Reports (E) — assembled report + presigned artifacts for the owner', () => {
  let pg: PostgreSqlContainer;
  let vault: StartedTestContainer;
  let minio: StartedTestContainer;
  let app: NestFastifyApplication;
  let pool: InstanceType<typeof Pool>;
  let mc: MinioClient;
  const fetchSpy = vi.fn();
  const BUCKET = 'autosploit-reports';

  beforeAll(async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/auth/callback';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';

    // --- real Postgres ---
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    pool = new Pool({ connectionString: pg.getConnectionUri() });
    await migrate(drizzle(pool), {
      migrationsFolder: path.resolve(
        fileURLToPath(import.meta.url),
        '../../src/db/migrations',
      ),
    });

    // --- real Vault Transit (Identity boots the token vault) ---
    vault = await new GenericContainer('hashicorp/vault:1.15')
      .withExposedPorts(8200)
      .withCommand(['server', '-dev', '-dev-root-token-id', 'root-token'])
      .start();
    const vaultEndpoint = `http://${vault.getHost()}:${vault.getMappedPort(8200)}`;
    process.env.VAULT_ADDR = vaultEndpoint;
    process.env.VAULT_TOKEN = 'root-token';
    const vaultAdmin = NodeVault({ endpoint: vaultEndpoint, token: 'root-token' });
    await vaultAdmin.mount({ mount_point: 'transit', type: 'transit' });
    await vaultAdmin.transitCreateKey({ name: 'github-tokens' });

    // --- MinIO (object store) — E's S3 client points here ---
    minio = await new GenericContainer('minio/minio:latest')
      .withExposedPorts(9000)
      .withEnvironment({
        MINIO_ROOT_USER: 'minioadmin',
        MINIO_ROOT_PASSWORD: 'minioadmin',
      })
      .withCommand(['server', '/data'])
      .withWaitStrategy(Wait.forLogMessage(/API:/))
      .start();
    process.env.S3_ENDPOINT = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    process.env.S3_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY = 'minioadmin';
    process.env.S3_SECRET_KEY = 'minioadmin';
    mc = new MinioClient({
      endPoint: minio.getHost(),
      port: minio.getMappedPort(9000),
      useSSL: false,
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
    });
    await mc.makeBucket(BUCKET, 'us-east-1').catch(() => undefined);

    // --- GitHub mocked (the one external call in the login flow) ---
    const realFetch = globalThis.fetch.bind(globalThis);
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return { ok: true, json: async () => ({ access_token: GITHUB_TOKEN }) };
      }
      if (url === 'https://api.github.com/user') {
        return { ok: true, json: async () => GITHUB_USER };
      }
      return realFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchSpy);

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
    );
    await app.register(cookie);
    await app.init();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await pg?.stop();
    await vault?.stop();
    await minio?.stop();
    vi.unstubAllGlobals();
  }, 120_000);

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

  function userIdOf(accessToken: string): string {
    return decodeJwt(accessToken).sub as string;
  }

  // Seed an engagement row directly (C's write path is not under test here).
  async function seedEngagement(userId: string, state: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO engagements (id, user_id, repo_full_name, state)
       VALUES ($1, $2, $3, $4)`,
      [id, userId, 'alice/app-docker', state],
    );
    return id;
  }

  async function seedFinding(
    engagementId: string,
    sourceId: string,
    severity: string,
    title: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO findings (engagement_id, source_id, severity, title, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [engagementId, sourceId, severity, title, JSON.stringify({ id: sourceId })],
    );
  }

  it('serves the owner an assembled report whose artifacts download via presigned URL', async () => {
    const accessToken = await login();
    const userId = userIdOf(accessToken);
    const engagementId = await seedEngagement(userId, 'completed');
    await seedFinding(engagementId, 'F-001', 'high', 'sqli in /login');
    await seedFinding(engagementId, 'F-002', 'medium', 'reflected xss');

    // The producer (worker / S3 sink) lands artifacts under report/<id>/…; upload
    // stand-ins so the presigned GETs resolve to real bytes.
    const rendered = JSON.stringify({ completed: true, findings: 2 });
    await mc.putObject(BUCKET, `report/${engagementId}/report.json`, rendered);
    await mc.putObject(
      BUCKET,
      `report/${engagementId}/events.jsonl`,
      '{"type":"finding","data":{"id":"F-001"}}\n',
    );
    await mc.putObject(
      BUCKET,
      `report/${engagementId}/memory-bundle.tar.gz`,
      Buffer.from('memory-bundle-bytes'),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/engagements/${engagementId}/report`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.engagementId).toBe(engagementId);
    expect(body.state).toBe('completed');
    // Findings from D (seam 3), newest first.
    expect(body.findings.map((f: { sourceId: string }) => f.sourceId)).toEqual([
      'F-002',
      'F-001',
    ]);

    // Every artifact carries a presigned URL that actually downloads its object.
    const rurl = body.artifacts.rendered.url as string;
    expect(rurl).toContain(`report/${engagementId}/report.json`);
    const download = await fetch(rurl);
    expect(download.ok).toBe(true);
    expect(await download.text()).toBe(rendered);

    const memUrl = body.artifacts.memoryBundle.url as string;
    const memDownload = await fetch(memUrl);
    expect(await memDownload.text()).toBe('memory-bundle-bytes');

    // Exit gate: no write-back into D — the findings projection is unchanged, and
    // E wrote exactly one reports row for the engagement.
    const findingCount = await pool.query(
      'SELECT count(*)::int AS n FROM findings WHERE engagement_id = $1',
      [engagementId],
    );
    expect(findingCount.rows[0].n).toBe(2);
    const reportRows = await pool.query(
      'SELECT count(*)::int AS n FROM reports WHERE engagement_id = $1',
      [engagementId],
    );
    expect(reportRows.rows[0].n).toBe(1);
  });

  it('is idempotent — a second GET keeps the same assembled_at (one reports row)', async () => {
    const accessToken = await login();
    const userId = userIdOf(accessToken);
    const engagementId = await seedEngagement(userId, 'halted');

    const first = await app.inject({
      method: 'GET',
      url: `/engagements/${engagementId}/report`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const second = await app.inject({
      method: 'GET',
      url: `/engagements/${engagementId}/report`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().assembledAt).toBe(first.json().assembledAt);

    const reportRows = await pool.query(
      'SELECT count(*)::int AS n FROM reports WHERE engagement_id = $1',
      [engagementId],
    );
    expect(reportRows.rows[0].n).toBe(1);
  });

  it('409s when the engagement has not reached a terminal state', async () => {
    const accessToken = await login();
    const userId = userIdOf(accessToken);
    const engagementId = await seedEngagement(userId, 'attacking');

    const res = await app.inject({
      method: 'GET',
      url: `/engagements/${engagementId}/report`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('404s a report for an engagement the caller does not own', async () => {
    const accessToken = await login();
    const engagementId = await seedEngagement(randomUUID(), 'completed');

    const res = await app.inject({
      method: 'GET',
      url: `/engagements/${engagementId}/report`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without a session', async () => {
    const engagementId = randomUUID();
    const res = await app.inject({
      method: 'GET',
      url: `/engagements/${engagementId}/report`,
    });
    expect(res.statusCode).toBe(401);
  });
});
