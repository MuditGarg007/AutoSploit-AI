import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedpandaContainer } from '@testcontainers/redpanda';
import { NestFactory } from '@nestjs/core';
import cookie from '@fastify/cookie';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pkg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kafka } from 'kafkajs';
import NodeVault from 'node-vault';
import { AppModule } from '../src/app.module.js';
import { IngestTokenService } from '../src/domains/lifecycle/ingest-token.service.js';
import { ProjectorConsumer } from '../src/domains/telemetry/consumers/projector.consumer.js';
import { AuditConsumer } from '../src/domains/telemetry/consumers/audit.consumer.js';

const { Pool } = pkg;

// Component D-b gate: the projector + audit consumer groups turn the topic into
// findings / cost / audit_log rows; the tables can be DROPPED and fully REBUILT by
// replaying the topic with a fresh consumer group (event-sourcing proof), and every
// tool call appears in the immutable audit trail — all without touching the live
// SSE path (docs/control-plane.md §12 gate D-b). Real Postgres + Redis + Redpanda.
describe('Telemetry (D-b) — durable consumers: projector + audit, rebuildable by replay', () => {
  let pg: PostgreSqlContainer;
  let redis: StartedTestContainer;
  let vault: StartedTestContainer;
  let redpanda: Awaited<ReturnType<RedpandaContainer['start']>>;
  let app: NestFastifyApplication;
  let ingestTokens: IngestTokenService;
  const fetchSpy = vi.fn();
  const GITHUB_USER = { id: 12345, login: 'alice' };
  const GITHUB_TOKEN = 'ghp_fake_github_access_token_1234567890abcdef';
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

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('waitFor timed out');
  }

  function cookiesOf(headers: Record<string, unknown>): string {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  }

  beforeAll(async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/auth/callback';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';
    process.env.INGEST_TOKEN_SIGNING_KEY = 'test-ingest-signing-key';

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

    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

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

    redpanda = await new RedpandaContainer('redpandadata/redpanda:latest').start();
    process.env.KAFKA_BROKERS = redpanda.getBootstrapServers();
    process.env.SCHEMA_REGISTRY_URL = redpanda.getSchemaRegistryAddress();

    const realFetch = globalThis.fetch.bind(globalThis);
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return { ok: true, json: async () => ({ access_token: GITHUB_TOKEN }) };
      }
      if (url === 'https://api.github.com/user') {
        return { ok: true, json: async () => GITHUB_USER };
      }
      if (url === 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member') {
        return { ok: true, json: async () => [REPO_DOCKERFILE] };
      }
      if (url === 'https://api.github.com/repos/alice/app-docker/contents/') {
        return { ok: true, json: async () => [{ name: 'Dockerfile' }] };
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
    ingestTokens = app.get(IngestTokenService);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    await redis?.stop();
    await vault?.stop();
    await redpanda?.stop();
    vi.unstubAllGlobals();
  }, 60_000);

  async function newPool(): Promise<pkg.Pool> {
    return new Pool({ connectionString: pg.getConnectionUri() });
  }

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

  async function createEngagement(accessToken: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/engagements',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { repoId: 101, repoFullName: 'alice/app-docker' },
    });
    const body = res.json();
    return body?.engagement?.id;
  }

  function event(type: string, data: Record<string, unknown>) {
    return { ts: new Date().toISOString(), type, data };
  }

  async function ingest(engagementId: string, ingestToken: string, ev: unknown) {
    const res = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: ev,
    });
    return res.statusCode;
  }

  it('projects findings/cost and records every tool call, then rebuilds identically on replay', { timeout: 120_000 }, async () => {
    const accessToken = await login();
    const engagementId = await createEngagement(accessToken);
    expect(engagementId).toBeTruthy();
    const ingestToken = await ingestTokens.mint(engagementId!);

    // --- ingest a realistic batch ---
    const finding1 = { id: 'F-001', severity: 'high', title: 'RCE in /api', evidence: 'e1', repro: 'r1' };
    const finding2 = { id: 'F-002', severity: 'low', title: 'Header leak', evidence: 'e2', repro: 'r2' };
    expect(await ingest(engagementId!, ingestToken, event('finding', finding1))).toBe(202);
    expect(await ingest(engagementId!, ingestToken, event('finding', finding2))).toBe(202);
    expect(await ingest(engagementId!, ingestToken, event('cost', { tokens: 100, usd: 0.001234, caps: {}, tool_calls: 1 }))).toBe(202);
    expect(await ingest(engagementId!, ingestToken, event('tool_call', { id: 'T-1', name: 'http', args: { url: 'x' } }))).toBe(202);
    expect(await ingest(engagementId!, ingestToken, event('tool_result', { id: 'T-1', name: 'http', is_error: false }))).toBe(202);
    expect(await ingest(engagementId!, ingestToken, event('phase', { stage: 'recon' }))).toBe(202);

    // --- projector + audit consumers land the rows ---
    const pool = await newPool();
    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM findings WHERE engagement_id = $1`,
        [engagementId],
      );
      return rows[0].n === 2;
    });

    const { rows: costRows } = await pool.query(
      `SELECT tokens, usd_micros FROM cost WHERE engagement_id = $1`,
      [engagementId],
    );
    expect(costRows).toHaveLength(1);
    expect(costRows[0].tokens).toBe(100);
    expect(costRows[0].usd_micros).toBe(1234);

    // Audit: every tool_call + tool_result, immutable (no UPDATE/DELETE path).
    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE engagement_id = $1`,
        [engagementId],
      );
      return rows[0].n === 2;
    });
    const { rows: auditRows } = await pool.query(
      `SELECT event_type, payload FROM audit_log WHERE engagement_id = $1 ORDER BY ts`,
      [engagementId],
    );
    expect(auditRows.map((r) => r.event_type).sort()).toEqual(['tool_call', 'tool_result']);

    // --- event-sourcing proof: drop the tables, replay the topic ---
    await pool.query('TRUNCATE findings, cost, audit_log');

    // A fresh consumer group from the beginning rebuilds everything by driving
    // the SAME production handlers (ProjectorConsumer.handle / AuditConsumer.handle)
    // — the rebuild path is identical to the live path (plan §7 replay proof).
    const projector = app.get(ProjectorConsumer);
    const audit = app.get(AuditConsumer);
    const kafka = new Kafka({
      clientId: 'replay-test',
      brokers: [redpanda.getBootstrapServers()],
    });
    const consumer = kafka.consumer({
      groupId: `autosploit-projector-replay-${Math.random().toString(36).slice(2)}`,
    });
    await consumer.connect();
    await consumer.subscribe({ topic: 'autosploit.events', fromBeginning: true });
    await consumer.run({
      eachMessage: async (payload) => {
        await projector.handle(payload);
        await audit.handle(payload);
      },
    });

    // The fresh group reads the whole topic from the beginning.
    await new Promise((r) => setTimeout(r, 8_000));
    await consumer.disconnect();

    // Tables fully rebuilt — identical to the pre-truncate state.
    const { rows: rebuiltFindings } = await pool.query(
      `SELECT source_id, severity, title FROM findings WHERE engagement_id = $1 ORDER BY source_id`,
      [engagementId],
    );
    expect(rebuiltFindings.map((r) => r.source_id).sort()).toEqual(['F-001', 'F-002']);
    expect(rebuiltFindings[0].severity).toBe('high');

    const { rows: rebuiltCost } = await pool.query(
      `SELECT tokens, usd_micros FROM cost WHERE engagement_id = $1`,
      [engagementId],
    );
    expect(rebuiltCost).toHaveLength(1);
    expect(rebuiltCost[0].tokens).toBe(100);
    expect(rebuiltCost[0].usd_micros).toBe(1234);

    const { rows: rebuiltAudit } = await pool.query(
      `SELECT event_type FROM audit_log WHERE engagement_id = $1`,
      [engagementId],
    );
    expect(rebuiltAudit.map((r) => r.event_type).sort()).toEqual(['tool_call', 'tool_result']);

    await pool.end();
  });
});
