import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Registry, Counter, Gauge } from 'prom-client';
import { PROMETHEUS_REGISTRY, type Metrics } from './metrics.js';
import { ObservabilityInterceptor } from './observability.interceptor.js';
import { MetricsController } from './metrics.controller.js';

// Observable cross-cutting module (docs/component-h-hardening.md §3.4). Like Quota,
// this is middleware, not a domain — it observes from the outside, owns no table and
// adds no domain route (only the /metrics scrape). @Global() so any service can
// inject the registry / metrics without re-importing.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: PROMETHEUS_REGISTRY,
      useFactory: (): Registry => new Registry(),
    },
    {
      provide: 'METRICS',
      inject: [PROMETHEUS_REGISTRY],
      useFactory: (registry: Registry): Metrics => ({
        httpRequests: new Counter({
          name: 'autosploit_http_requests_total',
          help: 'HTTP requests served, labeled by route + method + status.',
          labelNames: ['route', 'method', 'status'],
          registers: [registry],
        }),
        httpErrors: new Counter({
          name: 'autosploit_http_errors_total',
          help: 'HTTP 5xx responses, labeled by route.',
          labelNames: ['route'],
          registers: [registry],
        }),
        dispatchRejections: new Counter({
          name: 'autosploit_dispatch_rejections_total',
          help: 'POST /engagements rejections (quota 429, validation, etc.).',
          labelNames: ['reason'],
          registers: [registry],
        }),
        queueDepth: new Gauge({
          name: 'autosploit_engagement_queue_depth',
          help: 'Current BullMQ engagement queue depth by status.',
          labelNames: ['status'],
          registers: [registry],
        }),
        ingestAccepted: new Counter({
          name: 'autosploit_ingest_accepted_total',
          // Labeled by event TYPE (bounded: phase/tool/finding/cost), NOT by
          // engagement_id — a per-engagement label is unbounded cardinality and
          // would blow up the series count. Per-engagement correlation is the
          // trace's job (§6.2), not a metric label.
          help: 'Events accepted by the ingest endpoint, labeled by event type.',
          labelNames: ['type'],
          registers: [registry],
        }),
      }),
    },
    { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  ],
  exports: [PROMETHEUS_REGISTRY, 'METRICS'],
})
export class ObservabilityModule {}