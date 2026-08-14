import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { AppModule } from './app.module.js';

// Fastify adapter (docs/control-plane.md §9.1) — keeps native SSE for the
// Telemetry gateway; the SSE route is a raw Nest route, not a tRPC subscription.
// @fastify/cookie gives the Identity slice its httpOnly refresh-token cookie
// (A, §4.A) — registered here because Fastify plugins are platform-level.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  await app.register(cookie);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
