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
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import NodeVault from 'node-vault';
import pkg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';
import { EnvService } from '../src/config/env.service.js';
import { IngestService } from '../src/domains/telemetry/ingest/ingest.service.js';
import { LifecycleService } from '../src/domains/lifecycle/lifecycle.service.js';
import { QuotaService } from '../src/core/quota/quota.service.js';

const { Pool } = pkg;

// ---------------------------------------------------------------------------
// Unit: QuotaService decision logic (docs/component-q-quota.md §7, §10).
// No containers — plain stubs over the Redis meter + the C read.
// ---------------------------------------------------------------------------
describe('QuotaService.check / assertUnderCap truth table', () => {
  interface StubEnv {
    quotaMaxUsdMicros: number;
    quotaMaxFindings: number;
    quotaMaxConcurrent: number;
    quotaFailOpen: boolean;
  }
  function service(
    env: StubEnv,
    redis: { usd?: number; findings?: number; fail?: boolean } = {},
    active = 0,
  ): QuotaService {
    const stubRedis = {
      get: async () => {
        if (redis.fail) throw new Error('redis down');
        return redis.usd === undefined ? null : String(redis.usd);
      },
      scard: async () => {
        if (redis.fail) throw new Error('redis down');
        return redis.findings ?? 0;
      },
    };
    const lifecycle = { countActive: async () => active };
    return new QuotaService(
      stubRedis as unknown as Redis,
      env as unknown as EnvService,
      lifecycle as unknown as LifecycleService,
    );
  }

  it('treats a 0 cap as disabled (default deploy = no behaviour change)', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 0, quotaMaxFindings: 0, quotaMaxConcurrent: 0, quotaFailOpen: true },
      { usd: 99_000_000, findings: 500 },
      9,
    );
    const d = await svc.check('u1');
    expect(d.ok).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('flags over-spend as reason=spend with the live snapshot', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 4_000_000, quotaMaxFindings: 0, quotaMaxConcurrent: 0, quotaFailOpen: true },
      { usd: 5_000_000 },
    );
    const d = await svc.check('u1');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('spend');
    expect(d.snapshot.usdMicros).toBe(5_000_000);
  });

  it('flags over-findings as reason=findings', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 0, quotaMaxFindings: 2, quotaMaxConcurrent: 0, quotaFailOpen: true },
      { findings: 3 },
    );
    const d = await svc.check('u1');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('findings');
  });

  it('flags over-concurrency as reason=concurrency', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 0, quotaMaxFindings: 0, quotaMaxConcurrent: 2, quotaFailOpen: true },
      {},
      2,
    );
    const d = await svc.check('u1');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('concurrency');
  });

  it('fails open when the meter is unreachable and QUOTA_FAIL_OPEN', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 100, quotaMaxFindings: 0, quotaMaxConcurrent: 0, quotaFailOpen: true },
      { fail: true },
    );
    const d = await svc.check('u1');
    expect(d.ok).toBe(true); // unknown meter → under cap, dispatch proceeds
    await expect(svc.assertUnderCap('u1')).resolves.toBeUndefined();
  });

  it('fails closed (meter-unavailable 429) when QUOTA_FAIL_OPEN=false', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 100, quotaMaxFindings: 0, quotaMaxConcurrent: 0, quotaFailOpen: false },
      { fail: true },
    );
    try {
      await svc.assertUnderCap('u1');
      expect.unreachable('should have thrown 429');
    } catch (err) {
      const e = err as { getStatus?: () => number; getResponse?: () => unknown };
      expect(e.getStatus?.()).toBe(429);
      const resp = e.getResponse?.() as { reason?: string };
      expect(resp.reason).toBe('meter_unavailable');
    }
  });

  it('assertUnderCap throws 429 with reason + snapshot when over', async () => {
    const svc = service(
      { quotaMaxUsdMicros: 4_000_000, quotaMaxFindings: 0, quotaMaxConcurrent: 0, quotaFailOpen: true },
      { usd: 5_000_000 },
    );
    try {
      await svc.assertUnderCap('u1');
      expect.unreachable('should have thrown 429');
    } catch (err) {
      const e = err as { getStatus?: () => number; getResponse?: () => unknown };
      expect(e.getStatus?.()).toBe(429);
      const resp = e.getResponse?.() as {
        error?: string;
        reason?: string;
        snapshot?: { usdMicros: number };
      };
      expect(resp.error).toBe('quota_exceeded');
      expect(resp.reason).toBe('spend');
      expect(resp.snapshot?.usdMicros).toBe(5_000_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: the exit gate (docs/component-q-quota.md §13). Real Postgres +
// Redis + Redpanda via Testcontainers. Each cap scenario boots its own app
// because EnvService snapshots the QUOTA_* vars at construction; each scenario
// logs in a DIFFERENT GitHub user so meters never leak across scenarios.
// ---------------------------------------------------------------------------
describe('Quota (Q) — per-user caps enforced at POST /engagements before enqueue', () => {
  let pg: PostgreSqlContainer;
  let redis: StartedTestContainer;
  let vault: StartedTestContainer;
  let redpanda: Awaited<ReturnType<RedpandaContainer['start']>>;
  let redisClient: Redis;
  let app: NestFastifyApplication | null = null;
  let ingestService: IngestService;
  let engagementsQueue: Queue;
  const fetchSpy = vi.fn();
  // Mutable so each scenario logs in as a distinct GitHub user (distinct meter).
  let githubUser = { id: 12345, login: 'alice' };
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

  async function waitFor(
    fn: () => Promise<boolean>,
    timeoutMs = 30_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 150));
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
    // CONDUCTOR_CMD left at its default ('conductor'): the rare successful
    // dispatch enqueues a job whose spawn fails with ENOENT → the worker lands
    // the row failed[internal] harmlessly. No fixture files are written and the
    // spec never depends on a terminal state.

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

    // --- real Redis (quota meter + BullMQ) ---
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

    // --- real Redpanda (topic the quota aggregator consumes) ---
    redpanda = await new RedpandaContainer('redpandadata/redpanda:latest').start();
    process.env.KAFKA_BROKERS = redpanda.getBootstrapServers();
    process.env.SCHEMA_REGISTRY_URL = redpanda.getSchemaRegistryAddress();

    // --- mock GitHub (login only); pass real network through ---
    const realFetch = globalThis.fetch.bind(globalThis);
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return { ok: true, json: async () => ({ access_token: GITHUB_TOKEN }) };
      }
      if (url === 'https://api.github.com/user') {
        return { ok: true, json: async () => githubUser };
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

    engagementsQueue = new Queue('engagements', {
      connection: { url: process.env.REDIS_URL },
    });
  }, 300_000);

  afterAll(async () => {
    await engagementsQueue?.close();
    await app?.close();
    await redisClient?.quit();
    await pg?.stop();
    await redis?.stop();
    await vault?.stop();
    await redpanda?.stop();
    vi.unstubAllGlobals();
  }, 60_000);

  // Boot a fresh app with the CURRENT process.env (the QUOTA_* caps snapshot at
  // construction). Closing the previous app first releases the Kafka consumer
  // group + BullMQ worker so the next boot re-joins cleanly. Any jobs a previous
  // scenario enqueued are drained first so the next worker never picks up a
  // stray job against the previous app's (now-closed) Postgres pool.
  async function bootApp(): Promise<void> {
    if (app) {
      await app.close();
      app = null;
    }
    await engagementsQueue.drain();
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
    );
    await app.register(cookie);
    await app.init();
    ingestService = app.get(IngestService);
  }

  async function setCaps(caps: {
    usdMicros?: number;
    findings?: number;
    concurrent?: number;
    failOpen?: boolean;
  }): Promise<void> {
    process.env.QUOTA_MAX_USD_MICROS = String(caps.usdMicros ?? 0);
    process.env.QUOTA_MAX_FINDINGS = String(caps.findings ?? 0);
    process.env.QUOTA_MAX_CONCURRENT = String(caps.concurrent ?? 0);
    process.env.QUOTA_FAIL_OPEN = caps.failOpen === false ? 'false' : 'true';
  }

  async function newPool(): Promise<pkg.Pool> {
    return new Pool({ connectionString: pg.getConnectionUri() });
  }

  async function login(): Promise<string> {
    const start = await app!.inject({ method: 'GET', url: '/auth/github' });
    const state = cookiesOf(start.headers as Record<string, unknown>).match(
      /gh_oauth_state=([^;]+)/,
    )?.[1];
    const cb = await app!.inject({
      method: 'GET',
      url: `/auth/callback?code=fake-code&state=${state}`,
      headers: { cookie: `gh_oauth_state=${state}` },
    });
    return decodeURIComponent(
      (cb.headers.location as string).split('access_token=')[1],
    );
  }

  async function postEngagement(
    accessToken: string,
  ): Promise<{ status: number; body: any; engagementId?: string }> {
    const res = await app!.inject({
      method: 'POST',
      url: '/engagements',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { repoId: 101, repoFullName: 'alice/app-docker' },
    });
    const body = res.json();
    return { status: res.statusCode, body, engagementId: body?.engagement?.id };
  }

  // Seed an engagement row WITHOUT a conductor run (the spec writes fixture rows
  // straight into C's table, keeping them non-terminal), then push cost/finding
  // events onto the topic for it. Direct ingest keeps the events under our
  // control — the aggregator consumes them like any production event.
  async function seedEngagement(userId: string): Promise<{ id: string }> {
    const pool = await newPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO engagements (user_id, repo_full_name, state)
       VALUES ($1, 'alice/app-docker', 'queued') RETURNING id`,
      [userId],
    );
    await pool.end();
    return rows[0];
  }

  async function currentUserId(): Promise<string> {
    const pool = await newPool();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE github_id = $1 LIMIT 1`,
      [String(githubUser.id)],
    );
    await pool.end();
    return rows[0]?.id;
  }

  async function engagementCount(): Promise<number> {
    const pool = await newPool();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM engagements`,
    );
    await pool.end();
    return rows[0].n;
  }

  async function queueCounts(): Promise<string> {
    const counts = await engagementsQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
    );
    return [counts.waiting, counts.active, counts.completed, counts.failed].join(
      ':',
    );
  }

  function event(type: string, data: Record<string, unknown>) {
    return { ts: new Date().toISOString(), type, data };
  }

  // cost.data is the CUMULATIVE running total (§3.2): each push carries the
  // engagement's total-so-far, not a per-turn delta.
  async function pushCost(engagementId: string, tokens: number, usd: number) {
    await ingestService.push(
      engagementId,
      event('cost', { tokens, usd, tool_calls: 1, caps: {} }),
    );
  }

  async function pushFinding(engagementId: string, id: string) {
    await ingestService.push(
      engagementId,
      event('finding', {
        id,
        severity: 'low',
        title: 'x',
        evidence: 'x',
        repro: 'x',
      }),
    );
  }

  async function usdTotal(userId: string): Promise<number> {
    return Number((await redisClient.get(`quota:usd:user:${userId}`)) ?? 0);
  }

  async function findingsTotal(userId: string): Promise<number> {
    return redisClient.scard(`quota:findings:user:${userId}`);
  }

  describe('spend cap ($4) — the exit gate', () => {
    beforeAll(async () => {
      await setCaps({ usdMicros: 4_000_000 });
      await bootApp();
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      app = null;
    });

    it(
      'rejects an over-cap POST before enqueue: 429, no row, no job',
      { timeout: 120_000 },
      async () => {
        githubUser = { id: 20_001, login: 'spend-user' };
        const accessToken = await login();
        const userId = await currentUserId();
        const seeded = await seedEngagement(userId);

        // Cumulative spend climbs $1 → $5, crossing the $4 cap.
        await pushCost(seeded.id, 1000, 1.0);
        await pushCost(seeded.id, 5000, 5.0);
        await waitFor(async () => (await usdTotal(userId)) === 5_000_000);

        const beforeRows = await engagementCount();
        const beforeQueue = await queueCounts();

        const res = await postEngagement(accessToken);
        expect(res.status).toBe(429);
        expect(res.body.error).toBe('quota_exceeded');
        expect(res.body.reason).toBe('spend');
        expect(res.body.snapshot.usdMicros).toBe(5_000_000);

        // "before any job is enqueued" — proven, not assumed (§13).
        expect(await engagementCount()).toBe(beforeRows);
        expect(await queueCounts()).toBe(beforeQueue);
      },
    );

    it(
      'allows dispatch under the cap (row queued, job enqueued)',
      { timeout: 120_000 },
      async () => {
        // A fresh user with an empty meter.
        githubUser = { id: 20_002, login: 'under-user' };
        const accessToken = await login();
        const res = await postEngagement(accessToken);
        expect(res.status).toBe(201);
        expect(res.body?.engagement?.id).toBeTruthy();
      },
    );

    it(
      'is replay-idempotent: re-delivered cumulative cost events do not inflate',
      { timeout: 120_000 },
      async () => {
        githubUser = { id: 20_003, login: 'replay-user' };
        const accessToken = await login();
        void accessToken;
        const userId = await currentUserId();
        const seeded = await seedEngagement(userId);

        await pushCost(seeded.id, 1000, 1.0);
        await pushCost(seeded.id, 3000, 3.0);
        await waitFor(async () => (await usdTotal(userId)) === 3_000_000);

        // Re-produce the SAME cumulative events (what a topic replay re-delivers).
        await pushCost(seeded.id, 1000, 1.0);
        await pushCost(seeded.id, 3000, 3.0);

        // The forward-only max keeps the counter stable; sample for a few seconds.
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 300));
          expect(await usdTotal(userId)).toBe(3_000_000);
        }
      },
    );
  });

  describe('findings cap (2) with dedup', () => {
    beforeAll(async () => {
      await setCaps({ findings: 2 });
      await bootApp();
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      app = null;
    });

    it(
      'counts distinct handles via SCARD and rejects over the cap',
      { timeout: 120_000 },
      async () => {
        githubUser = { id: 20_004, login: 'findings-user' };
        const accessToken = await login();
        const userId = await currentUserId();
        const seeded = await seedEngagement(userId);

        // Distinct handles F-001, F-002 + a REPLAYED duplicate F-001.
        await pushFinding(seeded.id, 'F-001');
        await pushFinding(seeded.id, 'F-002');
        await pushFinding(seeded.id, 'F-001');
        await waitFor(async () => (await findingsTotal(userId)) === 2);

        const res = await postEngagement(accessToken);
        expect(res.status).toBe(429);
        expect(res.body.reason).toBe('findings');
        expect(res.body.snapshot.findings).toBe(2);
      },
    );
  });

  describe('concurrency cap (2) from C active count', () => {
    beforeAll(async () => {
      await setCaps({ concurrent: 2 });
      await bootApp();
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      app = null;
    });

    it(
      'blocks at the cap and releases when an engagement goes terminal',
      { timeout: 120_000 },
      async () => {
        githubUser = { id: 20_005, login: 'concurrent-user' };
        const accessToken = await login();
        const userId = await currentUserId();

        // Two non-terminal seeded engagements → at the cap.
        await seedEngagement(userId);
        await seedEngagement(userId);

        const blocked = await postEngagement(accessToken);
        expect(blocked.status).toBe(429);
        expect(blocked.body.reason).toBe('concurrency');
        expect(blocked.body.snapshot.activeEngagements).toBe(2);

        // Drive one seeded row terminal → the next dispatch passes.
        const pool = await newPool();
        await pool.query(
          `UPDATE engagements SET state = 'completed'
           WHERE user_id = $1 AND state = 'queued'
             AND id = (SELECT id FROM engagements
                       WHERE user_id = $1 AND state = 'queued' LIMIT 1)`,
          [userId],
        );
        await pool.end();

        const ok = await postEngagement(accessToken);
        expect(ok.status).toBe(201);
      },
    );
  });

  describe('all caps off = no-op on a default deploy', () => {
    beforeAll(async () => {
      await setCaps({});
      await bootApp();
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      app = null;
    });

    it(
      'arbitrary spend never blocks when every cap is 0',
      { timeout: 120_000 },
      async () => {
        githubUser = { id: 20_006, login: 'uncapped-user' };
        const accessToken = await login();
        const userId = await currentUserId();
        const seeded = await seedEngagement(userId);
        await pushCost(seeded.id, 99_000, 99.0);
        await waitFor(async () => (await usdTotal(userId)) === 99_000_000);

        const res = await postEngagement(accessToken);
        expect(res.status).toBe(201);
      },
    );
  });
});
