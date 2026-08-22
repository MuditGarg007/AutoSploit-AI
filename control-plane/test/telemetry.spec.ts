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
import { Redis } from 'ioredis';
import NodeVault from 'node-vault';
import pkg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';
import { IngestTokenService } from '../src/domains/lifecycle/ingest-token.service.js';

const { Pool } = pkg;

// Component D-a gate: a running engagement's events reach a subscribed SSE client
// in sub-second, ingest rejects an unsigned/mis-scoped token and a schema-violating
// event (fail-closed), and a reconnect with Last-Event-ID replays the missed
// backlog (docs/control-plane.md §12 gate D-a). Real Postgres + Redis + Redpanda
// via Testcontainers, real ingest token minted by C's IngestTokenService.
//
// Self-contained: unlike lifecycle.spec, no global fetch stub — the real ingest
// route is exercised end-to-end. GitHub is mocked only for the login dance.
describe('Telemetry (D-a) — live path: ingest → Redpanda → SSE bridge → Redis → SSE', () => {
  let pg: PostgreSqlContainer;
  let redis: StartedTestContainer;
  let vault: StartedTestContainer;
  let redisClient: Redis;
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

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('waitFor timed out');
  }

  function cookiesOf(headers: Record<string, unknown>): string {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  }

  beforeAll(async () => {
    // --- env required at boot (EnvService fail-fast) ---
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/auth/callback';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';
    process.env.INGEST_TOKEN_SIGNING_KEY = 'test-ingest-signing-key';

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

    // --- real Redis (last-mile) ---
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    redisClient = new Redis(process.env.REDIS_URL);

    // --- real Vault Transit (login encrypts the GitHub token) ---
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

    // --- real Redpanda (broker + schema registry) ---
    redpanda = await new RedpandaContainer('redpandadata/redpanda:latest').start();
    process.env.KAFKA_BROKERS = redpanda.getBootstrapServers();
    process.env.SCHEMA_REGISTRY_URL = redpanda.getSchemaRegistryAddress();

    // --- mock GitHub (login only); everything else uses the real network (e.g.
    // Schema Registry registration) ---
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
    // Real HTTP listener so the SSE subscriber uses a real socket (the exit gate
    // is "a subscribed browser", not an in-process inject).
    await app.listen(0, '127.0.0.1');
    ingestTokens = app.get(IngestTokenService);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await redisClient?.quit();
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

  // Create an engagement directly (no conductor — we only need the row + token).
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

  function validEvent(type = 'phase', overrides: Record<string, unknown> = {}) {
    return {
      ts: new Date().toISOString(),
      type,
      data: type === 'phase' ? { stage: 'recon' } : {},
      ...overrides,
    };
  }

  // A raw http SSE subscriber (the exit gate says "subscribed browser"; raw socket
  // is the browser contract). Reads frames until a predicate matches or timeout.
  async function sseCollect(
    url: string,
    opts: { headers?: Record<string, string>; until?: (f: SseFrame) => boolean } = {},
    timeoutMs = 15_000,
  ): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frame: blank line separates events.
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const frame = parseSse(part);
          if (frame) {
            frames.push(frame);
            if (opts.until?.(frame)) {
              // Abort CLOSES the socket (unlike reader.cancel which may keep it
              // pooled), so the server's stream loop unwinds promptly.
              controller.abort();
              return frames;
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return frames;
  }

  it('streams an accepted event over SSE sub-second and rejects bad auth/schema (fail-closed)', { timeout: 30_000 }, async () => {
    const accessToken = await login();
    const engagementId = await createEngagement(accessToken);
    expect(engagementId).toBeTruthy();
    const ingestToken = await ingestTokens.mint(engagementId!);

    // Open the SSE subscription FIRST (live tail), then push an event.
    const started = Date.now();
    const sub = sseCollect(
      `http://localhost:${app.getHttpServer().address().port}/engagements/${engagementId}/stream`,
      { headers: { authorization: `Bearer ${accessToken}` }, until: (f) => f.event === 'phase' },
    );

    // Valid event → 202.
    const event = validEvent('phase', { data: { stage: 'recon', host: '10.0.0.1' } });
    const res = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: event,
    });
    expect(res.statusCode).toBe(202);

    const frames = await sub;
    expect(frames.length).toBeGreaterThan(0);
    const phase = frames.find((f) => f.event === 'phase');
    expect(phase).toBeTruthy();
    expect(JSON.parse(phase!.data)).toMatchObject({ stage: 'recon' });
    expect(Date.now() - started).toBeLessThan(10_000); // sub-second-ish, CI-tolerant

    // Bad token → 401.
    const bad = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer not-a-real-token` },
      payload: event,
    });
    expect(bad.statusCode).toBe(401);

    // Valid token on a different :id → 403.
    const otherId = '00000000-0000-0000-0000-000000000000';
    const mis = await app.inject({
      method: 'POST',
      url: `/engagements/${otherId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: event,
    });
    expect(mis.statusCode).toBe(403);

    // Schema violation (missing required data key) → 422.
    const badSchema = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: validEvent('phase', { data: {} }),
    });
    expect(badSchema.statusCode).toBe(422);

    // Bad type → 422.
    const badType = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: validEvent('nonsense'),
    });
    expect(badType.statusCode).toBe(422);

    // Non-object data → 422.
    const badData = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: validEvent('phase', { data: 'not-an-object' }),
    });
    expect(badData.statusCode).toBe(422);

    // None of the rejected events reached the stream.
    const rejected = frames.filter((f) => f.event === 'nonsense');
    expect(rejected.length).toBe(0);
  });

  it('replays the backlog on fresh subscribe and only missed frames on Last-Event-ID reconnect', { timeout: 30_000 }, async () => {
    const accessToken = await login();
    const engagementId = await createEngagement(accessToken);
    expect(engagementId).toBeTruthy();
    const ingestToken = await ingestTokens.mint(engagementId!);
    const base = `http://localhost:${app.getHttpServer().address().port}/engagements/${engagementId}/stream`;

    // Produce two events while nobody is subscribed.
    await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: validEvent('phase', { data: { stage: 'recon' } }),
    });
    await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: validEvent('phase', { data: { stage: 'exploit' } }),
    });

    // Wait for the SSE bridge to land both events in the Redis stream.
    await waitFor(async () => {
      const stream = await redisClient.xlen(`events:${engagementId}`);
      return stream >= 2;
    });

    // Fresh subscribe replays the whole backlog (both phases).
    let phases = 0;
    const fresh = await sseCollect(base, {
      headers: { authorization: `Bearer ${accessToken}` },
      until: () => ++phases >= 2,
    });
    const freshPhases = fresh.filter((f) => f.event === 'phase');
    expect(freshPhases.length).toBeGreaterThanOrEqual(2);

    // Reconnect with Last-Event-ID = the first frame's id → only missed frames.
    const lastId = freshPhases[0].id;
    const reconnect = await sseCollect(base, {
      headers: { authorization: `Bearer ${accessToken}`, 'last-event-id': lastId },
      // Stop once the first frame AFTER the cursor arrives (that's the missed one).
      until: (f) => f.event === 'phase' && f.id !== lastId,
    });
    const reconnectPhases = reconnect.filter((f) => f.event === 'phase');
    expect(reconnectPhases.length).toBeLessThan(freshPhases.length);
    expect(reconnectPhases.every((f) => f.id !== lastId)).toBe(true);
  });
});

interface SseFrame {
  id: string;
  event: string;
  data: string;
}

function parseSse(block: string): SseFrame | null {
  const lines = block.split('\n');
  const frame: SseFrame = { id: '', event: '', data: '' };
  for (const line of lines) {
    if (line.startsWith('id:')) frame.id = line.slice(3).trim();
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('data:')) frame.data += line.slice(5).trim();
  }
  if (!frame.id && !frame.event && !frame.data) return null;
  return frame;
}
