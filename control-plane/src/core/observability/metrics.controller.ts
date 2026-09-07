import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Registry } from 'prom-client';
import { PROMETHEUS_REGISTRY } from './metrics.js';

// Prometheus scrape endpoint (docs/component-h-hardening.md §6.1). Registry is the
// global prom-client registry; the plan's RED metrics (per-route + per-consumer
// group + queue depth + dispatch rejections) are registered against it by the
// module. The Pod /metrics annotation in the Helm chart points scrapers here.
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(PROMETHEUS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}