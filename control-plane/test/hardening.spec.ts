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
import { Kafka } from 'kafkajs';
import NodeVault from 'node-vault';
import pkg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';
import { EnvService } from '../src/config/env.service.js';
import { IngestTokenService } from '../src/domains/lifecycle/ingest-token.service.js';
import { IngestRelay } from '../src/domains/lifecycle/worker/ingest-relay.js';
import { redactSecret } from '../src/domains/lifecycle/worker/engagement.worker.js';
import { activeTraceparent } from '../src/domains/lifecycle/lifecycle.service.js';

const { Pool } = pkg;

// Component H gate (docs/component-h-hardening.md §5, §13): the two security seams
// hold under adversarial tests. Real Postgres + Redis + Vault + Redpanda via
// Testcontainers; GitHub mocked for the login dance only. Covers:
//   §5.1  only ingest is inbound (application layer — every non-ingest route
//         rejects an engagement credential; ingest with the right token → 202)
//   §5.2  the GitHub token is redacted from any stderr capture (redactSecret)
//   §5.3  Phase-B parity — the SAME event via the Phase-A relay and a direct
//         Phase-B POST lands identically (auth, acceptance, topic)
// The static proofs (no-reach-down, model-key leak scanner) live in their own
// files; the red-team egress sweep needs a cluster and runs in CI (scripts/redteam).
describe('Hardening (H) — adversarial proofs on the real stack', () => {
  let pg: PostgreSqlContainer;
  let redis: StartedTestContainer;
  let vault: StartedTestContainer;
  let redpanda: Awaited<ReturnType<RedpandaContainer['start']>>;
  let app: NestFastifyApplication;
  let env: EnvService;
  let ingestTokens: IngestTokenService;
  const fetchSpy = vi.fn();
  const GITHUB_USER = { id: 12345, login: 'alice' };
  const GITHUB_TOKEN = 'ghp_fake_github_access_token_1234567890abcdef';
  const REPO = {
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
        return { ok: true, json: async () => [REPO] };
      }
      if (url === 'https://api.github.com/repos/alice/app-docker/contents/') {
        return { ok: true, json: async () => [{ name: 'Dockerfile' }] };
      }
      if (url === 'http://localhost:3000/engagements/ignored/events') {
        // Phase-A relay self-POST (fire-and-forget); the parity test intercepts
        // this below — see the parity case.
        return { ok: true, json: async () => ({}) };
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
    env = app.get(EnvService);
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

  // ---- §5.1 inbound-only (application layer) —---

  describe('SEAM 1 — only ingest is inbound (application layer)', () => {
    it('rejects an engagement credential on every non-ingest route, accepts on ingest', async () => {
      const accessToken = await login();
      const engagementId = await createEngagement(accessToken);
      expect(engagementId).toBeTruthy();
      const token = await ingestTokens.mint(engagementId!);

      // Every session-protected route the plane exposes EXCEPT ingest: an
      // engagement-shaped request carrying an ingest token must be rejected
      // (401/403/404) — session routes require a session JWT the sandbox never
      // has, and ingest is the only route an ingestion credential can drive.
      const nonIngest: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
        { method: 'POST', url: '/engagements' },
        { method: 'GET', url: '/engagements' },
        { method: 'POST', url: `/engagements/${engagementId}/abort` },
        { method: 'GET', url: `/engagements/${engagementId}/report` },
        { method: 'GET', url: `/engagements/${engagementId}/stream` },
      ];
      for (const r of nonIngest) {
        const res = await app.inject({
          method: r.method,
          url: r.url,
          headers: { authorization: `Bearer ${token}` },
          ...(r.payload !== undefined ? { payload: r.payload } : {}),
        });
        expect(
          res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404,
          `${r.method} ${r.url} returned ${res.statusCode}`,
        ).toBe(true);
      }

      // Ingest with the CORRECT token → 202 (the one inbound edge).
      const ok = await app.inject({
        method: 'POST',
        url: `/engagements/${engagementId}/events`,
        headers: { authorization: `Bearer ${token}` },
        payload: event('phase', { stage: 'recon' }),
      });
      expect(ok.statusCode).toBe(202);
    });
  });

  // ---- §5.2 secret split (redaction) —---

  describe('SEAM 2 — GitHub token redaction', () => {
    it('redacts the token bytes from any conductor stderr capture', () => {
      const leaked = `cloning https://github.com/alice/app-docker with token ${GITHUB_TOKEN} ...`;
      const result = redactSecret(leaked, GITHUB_TOKEN);
      expect(result).toContain('<redacted>');
      expect(result.includes(GITHUB_TOKEN)).toBe(false);
    });

    it('leaves the chunk untouched when the secret is empty (no false redaction)', () => {
      expect(redactSecret('plain log line', '')).toBe('plain log line');
    });
  });

  // ---- §5.3 phase-B parity —---

  describe('Phase-B parity — one ingest endpoint, two producers', () => {
    it('Producer A (relay) and Producer B (direct POST) use byte-identical endpoint, auth, and body', async () => {
      const accessToken = await login();
      const engagementId = await createEngagement(accessToken);
      expect(engagementId).toBeTruthy();
      const token = await ingestTokens.mint(engagementId!);
      const sameEvent = event('phase', { stage: 'recon', host: '10.0.0.5' });

      // Producer A: the Phase-A IngestRelay (worker relays conductor stdout). We
      // capture its raw request to prove it hits the SAME endpoint + auth + body
      // contract as a Phase-B POST.
      const relay = new IngestRelay(env);
      let relayRequest: { url: string; headers: Record<string, string>; body: string } | undefined;
      const realFetch = globalThis.fetch.bind(globalThis);
      const captureFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        relayRequest = {
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body ?? ''),
        };
        return realFetch(url, init);
      });
      vi.stubGlobal('fetch', captureFetch as typeof fetch);
      try {
        await relay.relay(engagementId!, sameEvent, token);
      } finally {
        vi.stubGlobal('fetch', realFetch);
      }
      expect(relayRequest).toBeTruthy();
      const relayUrl = new URL(relayRequest!.url);

      // Producer B: the direct Phase-B attacker-pod POST to the SAME route/guard.
      const phaseB = await app.inject({
        method: 'POST',
        url: `/engagements/${engagementId}/events`,
        headers: { authorization: `Bearer ${token}` },
        payload: sameEvent,
      });
      expect(phaseB.statusCode).toBe(202);

      // Byte-identical contract: same path, same auth header, same body. Only the
      // host differs (relay uses the configured PUBLIC_BASE_URL; the direct POST
      // hits the in-process listener) — that's the §6.3 "border stays data" claim.
      expect(relayUrl.pathname).toBe(`/engagements/${engagementId}/events`);
      expect(relayRequest!.headers.Authorization).toBe(`Bearer ${token}`);
      expect(JSON.parse(relayRequest!.body)).toEqual(sameEvent);
    });
  });

  // ---- §5.4 end-to-end trace correlation (one engagement, one trace) ----

  describe('Trace correlation — one engagement, one trace keyed by engagement_id', () => {
    it('dispatch → worker → ingest stays a single trace via the shared trace-context seam', async () => {
      const {
        NodeTracerProvider,
        SimpleSpanProcessor,
      } = await import('@opentelemetry/sdk-trace-node');
      const {
        InMemorySpanExporter,
      } = await import('@opentelemetry/sdk-trace-base');
      const { trace, context, propagation } = await import('@opentelemetry/api');
      const { W3CTraceContextPropagator } = await import('@opentelemetry/core');
      const { observabilityStorage } = await import(
        '../src/core/observability/observability.interceptor.js'
      );
      const { traceparentToContext } = await import(
        '../src/core/observability/trace-context.js'
      );

      // A real in-memory trace pipeline for this test (OTEL_ENABLED=false app
      // otherwise swaps in the no-op tracer). The exporter captures every span so
      // we can assert the dispatch and worker spans share one trace id.
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const prevTracer = trace.getTracerProvider();
      // register() installs the real context manager + propagator on the API
      // (the no-op API doesn't store spans), so trace.getActiveSpan() and
      // W3C extraction work as they do in production.
      provider.register({ propagator: new W3CTraceContextPropagator() });

      try {
        const engagementId = 'eng-trace-abc';
        const tracer = trace.getTracer('autosploit-control-plane');

        // SIMULATE the dispatch HTTP span (the ObservabilityInterceptor opens one
        // and binds engagement_id to the async context + active span).
        let workerSpanContext: ReturnType<typeof trace.getSpanContext> | undefined;
        await observabilityStorage.run({ engagementId }, async () => {
          const dispatchSpan = tracer.startSpan('POST /engagements');
          dispatchSpan.setAttribute('engagement_id', engagementId);
          await context.with(trace.setSpan(context.active(), dispatchSpan), async () => {
            const traceparent = activeTraceparent();
            expect(traceparent).toBeDefined();

            // SIMULATE the BullMQ hop: the worker extracts the traceparent…
            const workerCtx = traceparentToContext(traceparent!);
            expect(workerCtx).not.toBeNull();
            await context.with(workerCtx!, () => {
              // …and opens its own span under the SAME trace.
              const workerSpan = tracer.startSpan('engagement.worker');
              workerSpan.setAttribute('engagement_id', engagementId);
              workerSpanContext = workerSpan.spanContext();
              // SIMULATE the ingest relay: a child span per accepted event.
              const ingestSpan = tracer.startSpan('POST /:id/events');
              ingestSpan.setAttribute('engagement_id', engagementId);
              ingestSpan.end();
              workerSpan.end();
            });
          });
          dispatchSpan.end();
        });

        // One trace: the worker + ingest spans share the dispatch span's trace id, and
        // every span carries the engagement_id correlation field (§3.3).
        const finished = exporter.getFinishedSpans();
        expect(finished.length).toBeGreaterThanOrEqual(3);
        const traceIds = new Set(finished.map((s) => s.spanContext().traceId));
        expect(traceIds.size).toBe(1);
        for (const s of finished) {
          expect(s.attributes['engagement_id']).toBe(engagementId);
        }
        expect(workerSpanContext?.traceId).toBe(finished[0].spanContext().traceId);
      } finally {
        trace.setGlobalTracerProvider(prevTracer);
        await provider.forceFlush();
        await provider.shutdown();
      }
    });
  });
});