import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { AppModule } from './app.module.js';
import { EnvService } from './config/env.service.js';
import { startOtel } from './core/observability/otel.js';
import { PinoLoggerAdapter } from './core/observability/pino-logger.adapter.js';

// Fastify adapter (docs/control-plane.md §9.1) — keeps native SSE for the
// Telemetry gateway; the SSE route is a raw Nest route, not a tRPC subscription.
// @fastify/cookie gives the Identity slice its httpOnly refresh-token cookie
// (A, §4.A) — registered here because Fastify plugins are platform-level.
async function bootstrap(): Promise<void> {
  // Start the OTel SDK BEFORE NestFactory so auto-instrumentation patches
  // Fastify, pg, ioredis, and kafkajs before any of them are used
  // (docs/component-h-hardening.md §6.2). Fail-open: disabled by default so
  // local/CI need no collector; an OTel init error must never prevent boot.
  const env = new EnvService();
  try {
    startOtel(env);
  } catch (err) {
    // §3.6 — visibility failure degrades tracing only, never the plane.
    console.error('Observability init skipped:', (err as Error).message);
  }

  // Pino structured logging (docs/control-plane.md §9.1): the plane's logger of
  // record. We swap it in as the Nest application LOGGER (not HTTP access-log
  // middleware) so structured JSON + the `engagement_id` correlation field apply
  // to every app log line without touching the Fastify middleware stack that the
  // raw SSE routes depend on (§6.2). JSON out everywhere; dev/CI need no transport.
  const logger = new PinoLoggerAdapter(env.logLevel);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );
  await app.register(cookie);

  // CORS for the browser frontend (Vercel). Credentialed cross-origin requests
  // (the client sends Bearer + the refresh cookie) require an explicit origin
  // allowlist — never '*' with credentials. Origins come from FRONTEND_URL.
  app.enableCors({
    origin: env.frontendUrls,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'accept', 'last-event-id'],
  });

  const port = Number(env.port ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();