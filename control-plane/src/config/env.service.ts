import { Injectable } from '@nestjs/common';

// Typed, fail-fast access to process.env. Reads once at construction so a missing
// required var crashes boot, not a request. OPENROUTER_API_KEY is deliberately
// absent — the control plane never holds the model key (§6 secret split).
@Injectable()
export class EnvService {
  readonly port = Number(process.env.PORT ?? 3000);
  readonly databaseUrl = this.required('DATABASE_URL');
  readonly isProd = process.env.NODE_ENV === 'production';
  // Optional until P3 — nothing uses Redis before BullMQ (dispatch) + the SSE
  // last-mile land. Falls back to the local default so P0 dev/CI needs no fake var.
  readonly redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  // --- Lifecycle (slice C, P3) — BullMQ dispatch + conductor worker ---
  // The conductor CLI the worker shells for Phase A; the control plane never
  // holds OPENROUTER_API_KEY, the conductor resolves it from its own env (§6).
  readonly conductorCmd = process.env.CONDUCTOR_CMD ?? 'conductor';
  // Base --out dir for `conductor run`; the engagement workdir is <out>/<id> and
  // the surviving conductor.json record lives at <out>/<id>/conductor.json.
  readonly conductorOutDir = process.env.CONDUCTOR_OUT_DIR ?? '/tmp/autosploit-runs';
  readonly conductorTimeoutS = Number(process.env.CONDUCTOR_TIMEOUT_S ?? 3600);
  // How many engagements the BullMQ worker runs end to end at once (capacity lever
  // A1, docs/capacity-cpu-handoff.md). The attack phase is network-bound (~0 CPU),
  // so engagements overlap comfortably; the default 3 uses the otherwise-idle cores
  // on the single box. MUST pair with the conductor build gate (BUILD_CONCURRENCY,
  // lever A2) so overlapping engagements do not run the CPU-heavy build phase all
  // at once. Clamped to >=1 so a bad value can never stall the worker.
  readonly workerConcurrency = this.positiveInt(process.env.WORKER_CONCURRENCY, 3);
  // Shared C(mint) <-> D(validate) signing key for per-engagement ingest tokens
  // (§8.1). Optional at boot so pre-P3 slices (health/repos/identity) can start
  // without it; IngestTokenService fails fast if used without a key.
  readonly ingestTokenSigningKey = process.env.INGEST_TOKEN_SIGNING_KEY ?? '';
  // The plane's own base URL the worker POSTs relayed events to. Defaults to the
  // local port so P3 works without extra env; set PUBLIC_BASE_URL behind a proxy.
  readonly publicBaseUrl =
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${this.port}`;

  // --- GitHub OAuth (Identity slice A, §4.A) ---
  readonly githubClientId = this.required('GITHUB_CLIENT_ID');
  readonly githubClientSecret = this.required('GITHUB_CLIENT_SECRET');
  readonly githubCallbackUrl = this.required('GITHUB_CALLBACK_URL');

  // --- Sessions: short-lived access JWT + rotating refresh (jose) ---
  readonly jwtAccessSecret = this.required('JWT_ACCESS_SECRET');
  readonly jwtRefreshSecret = this.required('JWT_REFRESH_SECRET');
  readonly accessTokenTtlSec = Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 15 * 60);
  readonly refreshTokenTtlSec = Number(process.env.REFRESH_TOKEN_TTL_SEC ?? 30 * 24 * 60 * 60);

  // --- Vault (token vault, Transit engine, k8s auth — §9.1) ---
  // KUBERNETES_SERVICE_HOST is injected by k8s, not read from .env; when it is
  // set, VaultService authenticates with the pod service-account token. Outside
  // k8s (local dev + Testcontainers) the client falls back to VAULT_TOKEN, so
  // there is no static bootstrap secret in the app image.
  readonly vaultAddr = process.env.VAULT_ADDR ?? 'http://localhost:8200';
  readonly vaultTransitKey = this.required('VAULT_TRANSIT_KEY');
  readonly vaultToken = process.env.VAULT_TOKEN ?? process.env.VAULT_DEV_ROOT_TOKEN_ID ?? '';

  // --- Telemetry (slice D, P4) — Kafka backbone + S3 sink ---
  // Optional-but-fail-fast-on-use (pattern: ingestTokenSigningKey): the app must
  // boot without a broker (pre-D slices, local dev), but ingest/consumers refuse
  // to work when the broker is unset. Empty KAFKA_BROKERS = disabled (§ plan D).
  readonly kafkaBrokers = process.env.KAFKA_BROKERS ?? '';
  readonly schemaRegistryUrl = process.env.SCHEMA_REGISTRY_URL ?? '';
  readonly kafkaTopic = process.env.KAFKA_TOPIC ?? 'autosploit.events';
  readonly kafkaClientId = process.env.KAFKA_CLIENT_ID ?? 'control-plane';
  // Fixed partition count; key = engagement_id preserves per-engagement order.
  readonly kafkaPartitions = 3;
  // S3 object store (Kafka Connect S3 sink writes archives; Reports slice E reads
  // artifacts + mints presigned download URLs, §8.2, §4.E). The Connect worker
  // reads these at config time; Reports's own S3 client reads them at boot.
  // Empty S3_ACCESS_KEY = object store disabled (pre-E slices, local dev): the
  // Reports provider yields a null client and presigned URLs come back null.
  readonly s3Endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
  readonly s3Bucket = process.env.S3_BUCKET ?? 'autosploit-reports';
  readonly s3AccessKey = process.env.S3_ACCESS_KEY ?? '';
  readonly s3SecretKey = process.env.S3_SECRET_KEY ?? '';
  // TTL (seconds) of the presigned artifact download URLs the report serves.
  // Short by default — the URL is minted per request, not stored (§4.E).
  readonly reportUrlTtlS = Number(process.env.REPORT_URL_TTL_S ?? 15 * 60);

  // --- Quota (Component Q, P6) — per-user caps, all 0 = disabled ---
  // µUSD cap on a user's summed engagement spend (e.g. 5_000_000 = $5.00).
  readonly quotaMaxUsdMicros = Number(process.env.QUOTA_MAX_USD_MICROS ?? 0);
  readonly quotaMaxFindings = Number(process.env.QUOTA_MAX_FINDINGS ?? 0);
  // Max simultaneous non-terminal engagements per user (overview §3 concurrency cap).
  readonly quotaMaxConcurrent = Number(process.env.QUOTA_MAX_CONCURRENT ?? 0);
  // Fail-open when the Redis/topic meter is unreachable (harness ledger is the hard
  // per-engagement backstop, §3.5). false = block dispatch on an unreachable meter.
  readonly quotaFailOpen = (process.env.QUOTA_FAIL_OPEN ?? 'true') !== 'false';

  // --- Observability (Component H) — OTel + Prometheus + Pino (§9) ---
  // Master switch: when false (default), the OTel SDK is not started — local/CI
  // need no collector. The /metrics endpoint + Pino stay on; only trace export is
  // gated (fail-open, §3.6).
  readonly otelEnabled = (process.env.OTEL_ENABLED ?? 'false') === 'true';
  readonly otelExporterEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  readonly otelServiceName =
    process.env.OTEL_SERVICE_NAME ?? 'autosploit-control-plane';
  // Log level for Pino; JSON in prod, pretty in dev.
  readonly logLevel = process.env.LOG_LEVEL ?? (this.isProd ? 'info' : 'debug');

  // Parse an optional positive-integer env var, falling back to `fallback` for an
  // unset, non-numeric, or <1 value (so a typo can never stall the worker).
  private positiveInt(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
  }

  private required(key: string): string {
    const v = process.env[key];
    if (!v) throw new Error(`Missing required env var: ${key}`);
    return v;
  }
}
