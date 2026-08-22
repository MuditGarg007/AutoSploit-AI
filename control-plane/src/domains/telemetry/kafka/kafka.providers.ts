import { Kafka, type KafkaConfig, type Producer } from 'kafkajs';
import { EnvService } from '../../../config/env.service.js';

export const KAFKA = Symbol('KAFKA');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');
export const KAFKA_ADMIN = Symbol('KAFKA_ADMIN');

// Kafka backbone providers (docs/control-plane.md §8.2). All resolve to null when
// KAFKA_BROKERS is unset — the app must boot without a broker (pre-D slices), and
// every consumer/provider checks null before use (pattern: INGEST_TOKEN_SIGNING_KEY).
// The producer is connected lazily at bootstrap (onApplicationBootstrap in
// TelemetryModule), so a broker down at boot is a request-time failure, not a
// boot-time one.

function kafkaFactory(env: EnvService): Kafka | null {
  if (!env.kafkaBrokers) return null;
  const config: KafkaConfig = {
    clientId: env.kafkaClientId,
    brokers: env.kafkaBrokers.split(',').map((b) => b.trim()),
  };
  return new Kafka(config);
}

function kafkaOrNull(env: EnvService): Kafka {
  const kafka = kafkaFactory(env);
  if (!kafka) throw new Error('Kafka not configured');
  return kafka;
}

export const kafkaProvider = {
  provide: KAFKA,
  inject: [EnvService],
  useFactory: kafkaFactory,
};

export const kafkaProducerProvider = {
  provide: KAFKA_PRODUCER,
  inject: [EnvService],
  useFactory: (env: EnvService): Producer | null =>
    env.kafkaBrokers ? kafkaOrNull(env).producer() : null,
};

export const kafkaAdminProvider = {
  provide: KAFKA_ADMIN,
  inject: [EnvService],
  useFactory: (env: EnvService) =>
    env.kafkaBrokers ? kafkaOrNull(env).admin() : null,
};
