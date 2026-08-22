import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GenericContainer,
  Network,
  StartedNetwork,
  StartedTestContainer,
  Wait,
} from 'testcontainers';
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as MinioClient } from 'minio';
import NodeVault from 'node-vault';
import { AppModule } from '../src/app.module.js';
import { IngestTokenService } from '../src/domains/lifecycle/ingest-token.service.js';

const { Pool } = pkg;

// Mirrors the stock @testcontainers/redpanda bootstrap pattern (handoff §"Likely
// fix"): a wrapper script waits for the mapped host port, then runs Redpanda with
// --mode dev-container. We subclass GenericContainer so the dual-listener
// redpanda.yaml (with the real mapped host port) is copied in right after the
// container is created — the stock module does the same via containerStarted().
const STARTER_SCRIPT = '/testcontainers_start.sh';
const WAIT_FOR_SCRIPT_MESSAGE = 'Waiting for script...';

class RedpandaDualListenerContainer extends GenericContainer {
  async beforeContainerCreated(): Promise<void> {
    // Swap the wait strategy: first wait for the wrapper script's "Waiting for
    // script..." banner (printed immediately), so containerStarted() runs and
    // installs the real starter script + dual-listener yaml. The script itself
    // prints "Successfully started Redpanda!" after rpk finishes booting, which
    // satisfies the original log-message wait strategy (see containerStarted).
    this.waitStrategy = Wait.forLogMessage(WAIT_FOR_SCRIPT_MESSAGE);
    this.withEntrypoint(['sh']);
    this.withCommand([
      '-c',
      `echo '${WAIT_FOR_SCRIPT_MESSAGE}'; while [ ! -f ${STARTER_SCRIPT} ]; do sleep 0.1; done; ${STARTER_SCRIPT}`,
    ]);
  }

  async containerStarted(
    container: StartedTestContainer,
  ): Promise<void> {
    // The wrapper script prints this banner once Redpanda is fully up, so the
    // original Wait.forLogMessage('Successfully started Redpanda!') resolves
    // when the server is ready — no need to re-run the wait strategy here.
    const script = [
      '#!/bin/bash',
      'rpk redpanda start --mode dev-container --smp=1 --memory=1G',
      "echo 'Successfully started Redpanda!'",
    ].join('\n');
    const port = container.getMappedPort(9092);
    await container.copyContentToContainer([
      { content: script, target: STARTER_SCRIPT, mode: 0o777 },
      {
        content: dualListenerRedpandaYaml(port),
        target: '/etc/redpanda/redpanda.yaml',
      },
    ]);
  }
}

function dualListenerRedpandaYaml(hostKafkaPort: number): string {
  return `redpanda:
  admin:
    address: 0.0.0.0
    port: 9644
  kafka_api:
    - address: 0.0.0.0
      name: external
      port: 9092
      authentication_method: none
    - address: 0.0.0.0
      name: internal
      port: 9093
      authentication_method: none
  advertised_kafka_api:
    - address: 127.0.0.1
      name: external
      port: ${hostKafkaPort}
    - address: redpanda
      name: internal
      port: 9093
schema_registry:
  schema_registry_api:
    - address: 0.0.0.0
      name: main
      port: 8081
      authentication_method: none
schema_registry_client:
  brokers:
    - address: redpanda
      port: 9093
pandaproxy:
  pandaproxy_api:
    - address: 0.0.0.0
      port: 8082
      name: proxy-internal
  advertised_pandaproxy_api:
    - address: 127.0.0.1
      port: 8082
      name: proxy-internal
pandaproxy_client:
  brokers:
    - address: redpanda
      port: 9093
rpk:
  kafka_api:
    brokers:
    - redpanda:9093
`;
}

// Component D-b exit gate (docs/control-plane.md §12): "raw events land in the
// object store". Kafka Connect S3-sink connector (spec-literal — no custom batched
// archiver) runs against MinIO, all on one Docker network so Connect can reach the
// Redpanda broker by its network alias. Heavy + the flakiest spec, so it is
// isolated from the live-path specs (plan §8).
describe('Telemetry (D-b) — Kafka Connect S3 sink archives events to MinIO', () => {
  let network: StartedNetwork;
  let redpanda: StartedTestContainer;
  let minio: StartedTestContainer;
  let connect: StartedTestContainer;
  let pg: PostgreSqlContainer;
  let vault: StartedTestContainer;
  let redis: StartedTestContainer;
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

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 500));
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

    // --- one shared network: Connect must reach Redpanda + MinIO by alias ---
    network = await new Network().start();

    // Redpanda with a dual listener: `external` (host-visible, for kafkajs) and
    // `internal` (9093, reachable on the network via alias `redpanda`). The stock
    // @testcontainers/redpanda only advertises a host listener, which Connect
    // inside a container cannot reach — hence a hand-rolled GenericContainer that
    // mirrors the stock bootstrap pattern: a wrapper script waits for the mapped
    // host port (only known after the container starts), then launches Redpanda
    // with --mode dev-container (which fills rpc_server/developer_mode defaults),
    // and the dual-listener redpanda.yaml is copied in before the script runs.
    redpanda = await new RedpandaDualListenerContainer('redpandadata/redpanda:latest')
      .withName('autosploit-redpanda')
      .withNetwork(network)
      .withNetworkAliases('redpanda')
      .withUser('root:root')
      .withExposedPorts(9092, 8081)
      .start();

    // --- MinIO (object store) on the same network ---
    minio = await new GenericContainer('minio/minio:latest')
      .withName('autosploit-minio')
      .withNetwork(network)
      .withNetworkAliases('minio')
      .withExposedPorts(9000)
      .withEnvironment({
        MINIO_ROOT_USER: 'minioadmin',
        MINIO_ROOT_PASSWORD: 'minioadmin',
      })
      .withCommand(['server', '/data'])
      .withWaitStrategy(Wait.forLogMessage(/API:/))
      .start();

    // Create the bucket Connect writes into.
    const minioHost = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    const mc = new MinioClient({
      endPoint: minio.getHost(),
      port: minio.getMappedPort(9000),
      useSSL: false,
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
    });
    await mc.makeBucket('autosploit-reports', 'us-east-1').catch(() => undefined);

    // --- Kafka Connect (S3 sink worker). The base image bundles only the core
    // connectors, so install the S3 sink plugin via confluent-hub at startup. ---
    connect = await new GenericContainer(
      'confluentinc/cp-kafka-connect:7.6.0',
    )
      .withName('autosploit-connect')
      .withNetwork(network)
      .withNetworkAliases('connect')
      .withExposedPorts(8083)
      .withEnvironment({
        CONNECT_BOOTSTRAP_SERVERS: 'redpanda:9093',
        CONNECT_REST_ADVERTISED_HOST_NAME: 'connect',
        CONNECT_REST_PORT: '8083',
        CONNECT_GROUP_ID: 'connect-cluster',
        CONNECT_CONFIG_STORAGE_TOPIC: 'connect-configs',
        CONNECT_OFFSET_STORAGE_TOPIC: 'connect-offsets',
        CONNECT_STATUS_STORAGE_TOPIC: 'connect-status',
        // Single-node Redpanda — Connect's default replication factor of 3 makes
        // its internal topics uncreatable, so the worker never becomes ready and
        // connector PUTs time out.
        CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR: '1',
        CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR: '1',
        CONNECT_STATUS_STORAGE_REPLICATION_FACTOR: '1',
        CONNECT_KEY_CONVERTER: 'org.apache.kafka.connect.json.JsonConverter',
        CONNECT_VALUE_CONVERTER: 'org.apache.kafka.connect.json.JsonConverter',
        CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE: 'false',
        CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE: 'false',
        CONNECT_PLUGIN_PATH: '/usr/share/java,/usr/share/confluent-hub-components',
        CONNECT_LOG4J_OPTS: '-Dlog4j.configuration=file:/etc/kafka/connect-log4j.properties',
      })
      .withCommand([
        'sh',
        '-c',
        'confluent-hub install --no-prompt confluentinc/kafka-connect-s3:10.5.8 && /etc/confluent/docker/run',
      ])
      .withLogConsumer((stream) => {
        stream.on('data', (l: Buffer) => console.log('[connect]', l.toString()));
      })
      .withWaitStrategy(Wait.forLogMessage(/Kafka Connect started/))
      .start();

    // --- Postgres + Vault + Redis for the app boot ---
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
    const vaultAdmin = NodeVault({ endpoint: vaultEndpoint, token: 'root-token' });
    await vaultAdmin.mount({ mount_point: 'transit', type: 'transit' });
    await vaultAdmin.transitCreateKey({ name: 'github-tokens' });

    // --- the app produces to the SAME broker Connect consumes ---
    process.env.KAFKA_BROKERS = `127.0.0.1:${redpanda.getMappedPort(9092)}`;
    process.env.SCHEMA_REGISTRY_URL = `http://127.0.0.1:${redpanda.getMappedPort(8081)}`;

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
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    await redis?.stop();
    await vault?.stop();
    await connect?.stop();
    await minio?.stop();
    await redpanda?.stop();
    await network?.stop();
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

  it('archives a produced event to MinIO via the S3 sink connector', { timeout: 300_000 }, async () => {
    const accessToken = await login();
    const engagementId = await createEngagement(accessToken);
    expect(engagementId).toBeTruthy();
    const ingestToken = await ingestTokens.mint(engagementId!);

    // --- configure the S3 sink connector ---
    const connectPort = connect.getMappedPort(8083);
    const connectorConfig = {
      name: 'autosploit-s3-sink',
      'connector.class': 'io.confluent.connect.s3.S3SinkConnector',
      topics: 'autosploit.events',
      'tasks.max': '1',
      'key.converter': 'org.apache.kafka.connect.storage.StringConverter',
      'value.converter': 'org.apache.kafka.connect.json.JsonConverter',
      'value.converter.schemas.enable': 'false',
      'format.class': 'io.confluent.connect.s3.format.json.JsonFormat',
      's3.bucket.name': 'autosploit-reports',
      'store.url': 'http://minio:9000',
      's3.region': 'us-east-1',
      's3.path.style.access': 'true',
      'aws.access.key.id': 'minioadmin',
      'aws.secret.access.key': 'minioadmin',
      'flush.size': '1',
      'rotate.interval.ms': '1000',
      'storage.class': 'io.confluent.connect.s3.storage.S3Storage',
      'topics.dir': 'autosploit-events',
    };
    const put = await fetch(
      `http://127.0.0.1:${connectPort}/connectors/autosploit-s3-sink/config`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connectorConfig),
      },
    );
    expect(put.ok, `Connect config PUT failed: ${put.status} ${await put.text()}`).toBe(true);

    // Wait for the connector to be RUNNING.
    await waitFor(async () => {
      const res = await fetch(
        `http://127.0.0.1:${connectPort}/connectors/autosploit-s3-sink/status`,
      );
      if (!res.ok) return false;
      const status = (await res.json()) as { connector?: { state?: string } };
      return status.connector?.state === 'RUNNING';
    }, 60_000);

    // --- produce a known event via the real ingest path ---
    const res = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/events`,
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: {
        ts: new Date().toISOString(),
        type: 'finding',
        data: { id: 'F-001', severity: 'high', title: 'archived finding', evidence: 'e', repro: 'r' },
      },
    });
    expect(res.statusCode).toBe(202);

    // --- poll MinIO for an object and assert the event line landed ---
    const mc = new MinioClient({
      endPoint: minio.getHost(),
      port: minio.getMappedPort(9000),
      useSSL: false,
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
    });
    let archived: string | null = null;
    await waitFor(async () => {
      const objects: string[] = [];
      const stream = mc.listObjectsV2('autosploit-reports', '', true);
      for await (const obj of stream) {
        objects.push(obj.name ?? '');
      }
      if (objects.length === 0) return false;
      // Grab the first object's contents and look for our event.
      const buf = await mc.getObject('autosploit-reports', objects[0]);
      const chunks: Buffer[] = [];
      for await (const c of buf) chunks.push(c as Buffer);
      archived = Buffer.concat(chunks).toString('utf8');
      return archived.includes('F-001');
    }, 120_000);

    expect(archived).toContain('F-001');
    expect(archived).toContain('archived finding');
  });
});
