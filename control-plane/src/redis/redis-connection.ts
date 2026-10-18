import type { RedisOptions } from 'ioredis';
import { EnvService } from '../config/env.service.js';

// Pure connection-options builder — exported for unit testing (ioredis/BullMQ hide
// the options they were built with). Returns an overlay merged onto `{ url:
// env.redisUrl }` at every connection site (redis.module + both BullMQ sites).
//
// All creds env empty = empty overlay = plaintext, which preserves local dev /
// self-hosted redis:7-alpine. A CA pins verification to the managed provider's
// private CA (Aiven); a password without a CA still authenticates (TLS then rides
// on the rediss:// scheme in REDIS_URL, verified against system roots). Mirrors the
// Kafka buildKafkaConfig gating: auth/TLS turn on by credential presence, not a flag.
//
// Does NOT set maxRetriesPerRequest — the BullMQ sites add that themselves (required
// for BullMQ's blocking commands); the shared cache client keeps its fail-soft default.
export function buildRedisConnectionOptions(env: EnvService): RedisOptions {
  const opts: RedisOptions = {};
  if (env.redisUsername) opts.username = env.redisUsername;
  if (env.redisPassword) opts.password = env.redisPassword;
  if (env.redisTlsCa) opts.tls = { ca: [env.redisTlsCa], rejectUnauthorized: true };
  return opts;
}
