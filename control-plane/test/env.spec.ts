import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvService } from '../src/config/env.service.js';

// EnvService reads process.env once at construction (fail-fast), so each case sets
// WORKER_CONCURRENCY and constructs a fresh instance. The required vars below just
// satisfy the boot-time `required()` checks; only workerConcurrency is under test.
describe('EnvService.workerConcurrency (capacity lever A1)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://placeholder';
    process.env.GITHUB_CLIENT_ID = 'x';
    process.env.GITHUB_CLIENT_SECRET = 'x';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/cb';
    process.env.JWT_ACCESS_SECRET = 'x';
    process.env.JWT_REFRESH_SECRET = 'x';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';
    delete process.env.WORKER_CONCURRENCY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to 3 when unset', () => {
    expect(new EnvService().workerConcurrency).toBe(3);
  });

  it('honours a valid positive integer', () => {
    process.env.WORKER_CONCURRENCY = '5';
    expect(new EnvService().workerConcurrency).toBe(5);
  });

  it('falls back to 3 for a non-numeric value', () => {
    process.env.WORKER_CONCURRENCY = 'abc';
    expect(new EnvService().workerConcurrency).toBe(3);
  });

  it('falls back to 3 for a value below 1 (never stalls the worker)', () => {
    process.env.WORKER_CONCURRENCY = '0';
    expect(new EnvService().workerConcurrency).toBe(3);
  });

  it('falls back to 3 for a fractional value', () => {
    process.env.WORKER_CONCURRENCY = '2.5';
    expect(new EnvService().workerConcurrency).toBe(3);
  });
});
