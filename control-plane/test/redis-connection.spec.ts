import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvService } from '../src/config/env.service.js';
import { buildRedisConnectionOptions } from '../src/redis/redis-connection.js';

// buildRedisConnectionOptions is the single overlay reused by the shared SSE/quota
// client and both BullMQ sites (queue + worker), so its shape is the whole Redis-auth
// contract. EnvService reads process.env at construction, so each case sets env then
// builds fresh. The required() vars below just satisfy boot-time checks; only the
// REDIS_* keys are tested. All creds absent = empty overlay = plaintext local path.
describe('buildRedisConnectionOptions (Valkey auth/TLS wiring)', () => {
  const saved = { ...process.env };
  const CA = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://placeholder';
    process.env.GITHUB_CLIENT_ID = 'x';
    process.env.GITHUB_CLIENT_SECRET = 'x';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/cb';
    process.env.JWT_ACCESS_SECRET = 'x';
    process.env.JWT_REFRESH_SECRET = 'x';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';
    delete process.env.REDIS_USERNAME;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_TLS_CA;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is an empty overlay (plaintext) when no creds are set', () => {
    const opts = buildRedisConnectionOptions(new EnvService());
    expect(opts).toEqual({});
    expect(opts.tls).toBeUndefined();
    expect(opts.password).toBeUndefined();
    expect(opts.username).toBeUndefined();
  });

  it('sets password only (no TLS) when just a password is configured', () => {
    process.env.REDIS_PASSWORD = 'secret';
    const opts = buildRedisConnectionOptions(new EnvService());
    expect(opts).toEqual({ password: 'secret' });
    expect(opts.tls).toBeUndefined();
  });

  it('pins tls.ca + password for a managed Valkey with a CA', () => {
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_TLS_CA = CA;
    const opts = buildRedisConnectionOptions(new EnvService());
    expect(opts).toEqual({
      password: 'secret',
      tls: { ca: [CA], rejectUnauthorized: true },
    });
  });

  it('carries username, password and CA together', () => {
    process.env.REDIS_USERNAME = 'default';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_TLS_CA = CA;
    const opts = buildRedisConnectionOptions(new EnvService());
    expect(opts).toEqual({
      username: 'default',
      password: 'secret',
      tls: { ca: [CA], rejectUnauthorized: true },
    });
  });

  it('sets tls.ca alone when only a CA is configured', () => {
    process.env.REDIS_TLS_CA = CA;
    const opts = buildRedisConnectionOptions(new EnvService());
    expect(opts).toEqual({ tls: { ca: [CA], rejectUnauthorized: true } });
    expect(opts.password).toBeUndefined();
  });
});
