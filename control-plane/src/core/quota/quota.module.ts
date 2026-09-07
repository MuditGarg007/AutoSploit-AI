import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LifecycleModule } from '../../domains/lifecycle/lifecycle.module.js';
import { TelemetryModule } from '../../domains/telemetry/telemetry.module.js';
import { RedisModule } from '../../redis/redis.module.js';
import { QuotaService } from './quota.service.js';
import { QuotaAggregatorConsumer } from './quota-aggregator.consumer.js';
import { QuotaInterceptor } from './quota.interceptor.js';

// Q · Quota — cross-cutting middleware (docs/control-plane.md §3.3, §12). Rides on
// top of C and D: aggregates D's topic into the Redis meter, and reads C's owner +
// active-count through LifecycleService. NOT a domain slice — it owns no Postgres
// table and adds no client-facing route. Nothing in A–E imports this module; the
// only touch inside C is the @EnforceQuota() marker from core/ (the interceptor
// itself is registered globally here).
@Global()
@Module({
  imports: [LifecycleModule, RedisModule, TelemetryModule],
  providers: [
    QuotaService,
    QuotaAggregatorConsumer,
    { provide: APP_INTERCEPTOR, useClass: QuotaInterceptor },
  ],
  exports: [QuotaService],
})
export class QuotaModule {}
