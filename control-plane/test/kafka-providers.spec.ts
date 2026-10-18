import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvService } from '../src/config/env.service.js';
import { buildKafkaConfig } from '../src/domains/telemetry/kafka/kafka.providers.js';

// buildKafkaConfig is the single connection builder reused by the producer, admin and
// all four consumer groups, so its shape is the whole Kafka-auth contract. EnvService
// reads process.env at construction, so each case sets env then builds fresh. The
// required() vars below just satisfy boot-time checks; only the Kafka keys are tested.
describe('buildKafkaConfig (Kafka SASL/TLS wiring)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://placeholder';
    process.env.GITHUB_CLIENT_ID = 'x';
    process.env.GITHUB_CLIENT_SECRET = 'x';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:3000/cb';
    process.env.JWT_ACCESS_SECRET = 'x';
    process.env.JWT_REFRESH_SECRET = 'x';
    process.env.VAULT_TRANSIT_KEY = 'github-tokens';
    delete process.env.KAFKA_BROKERS;
    delete process.env.KAFKA_SASL_MECHANISM;
    delete process.env.KAFKA_USERNAME;
    delete process.env.KAFKA_PASSWORD;
    delete process.env.KAFKA_SSL_CA;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null when no broker is configured', () => {
    expect(buildKafkaConfig(new EnvService())).toBeNull();
  });

  it('stays plaintext (no ssl/sasl) for a self-hosted Redpanda broker', () => {
    process.env.KAFKA_BROKERS = 'redpanda:9092';
    const config = buildKafkaConfig(new EnvService());
    expect(config).toMatchObject({ clientId: 'control-plane', brokers: ['redpanda:9092'] });
    expect(config?.ssl).toBeUndefined();
    expect(config?.sasl).toBeUndefined();
  });

  it('builds ssl.ca + scram-sha-256 sasl for a managed broker with a CA', () => {
    process.env.KAFKA_BROKERS = 'svc.aivencloud.com:12345';
    process.env.KAFKA_SASL_MECHANISM = 'scram-sha-256';
    process.env.KAFKA_USERNAME = 'avnadmin';
    process.env.KAFKA_PASSWORD = 'secret';
    process.env.KAFKA_SSL_CA = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';
    const config = buildKafkaConfig(new EnvService());
    expect(config?.ssl).toEqual({
      ca: ['-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----'],
      rejectUnauthorized: true,
    });
    expect(config?.sasl).toEqual({
      mechanism: 'scram-sha-256',
      username: 'avnadmin',
      password: 'secret',
    });
  });

  it('turns TLS on (ssl:true) when a SASL mechanism is set without an explicit CA', () => {
    process.env.KAFKA_BROKERS = 'svc.aivencloud.com:12345';
    process.env.KAFKA_SASL_MECHANISM = 'scram-sha-256';
    process.env.KAFKA_USERNAME = 'avnadmin';
    process.env.KAFKA_PASSWORD = 'secret';
    const config = buildKafkaConfig(new EnvService());
    expect(config?.ssl).toBe(true);
    expect(config?.sasl).toMatchObject({ mechanism: 'scram-sha-256' });
  });

  it('splits and trims a comma-separated broker list', () => {
    process.env.KAFKA_BROKERS = 'a:9092, b:9092 ,c:9092';
    expect(buildKafkaConfig(new EnvService())?.brokers).toEqual(['a:9092', 'b:9092', 'c:9092']);
  });
});
