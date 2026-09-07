import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { EnvService } from '../../config/env.service.js';

// OTel Node SDK bootstrap (docs/component-h-hardening.md §6). Imported FIRST in
// main.ts, before NestFactory, so auto-instrumentation patches Fastify, pg,
// ioredis, and kafkajs before any of them are used. Guarded by OTEL_ENABLED
// (fail-open, §3.6): when disabled the plane behaves exactly as pre-H — no
// collector is required to boot locally or in CI.
//
// The exporter is OTLP/HTTP to a collector (e.g. Grafana Alloy / Tempo); the
// endpoint is env-configured. Resource attributes name the service so every
// span/metric/log line identifies this plane process.
export function startOtel(env: EnvService): NodeSDK | null {
  if (!env.otelEnabled) {
    return null;
  }
  if (!env.otelExporterEndpoint) {
    // Enabled but no collector endpoint: degrade visibility only (a tracing
    // exporter being down must never take the plane down, §3.6). Prefer a
    // no-op SDK over a failing export loop.
    throw new Error('OTEL_ENABLED is true but OTEL_EXPORTER_OTLP_ENDPOINT is empty');
  }
  const resource: Resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: env.otelServiceName,
  });
  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${env.otelExporterEndpoint}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return sdk;
}