import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DrizzleModule } from './db/drizzle.module.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthModule } from './core/health/health.module.js';
import { IdentityModule } from './domains/identity/identity.module.js';
import { ReposModule } from './domains/repos/repos.module.js';
import { LifecycleModule } from './domains/lifecycle/lifecycle.module.js';
import { TelemetryModule } from './domains/telemetry/telemetry.module.js';
import { ReportsModule } from './domains/reports/reports.module.js';

// Root wiring. Each of the five bounded contexts (docs/control-plane.md §4, the
// "vertical slices") is one Nest module with a hard table-ownership boundary; DI is
// what enforces that no context reaches into another's tables (§5). Quota is
// cross-cutting middleware (an Interceptor in core/), not a domain.
@Module({
  imports: [
    ConfigModule,
    DrizzleModule,
    RedisModule,
    HealthModule,
    IdentityModule, // A · Identity  — users, sessions, github_tokens
    ReposModule, // B · Repos     — repo_cache
    LifecycleModule, // C · Lifecycle — engagements (sole writer of state)
    TelemetryModule, // D · Telemetry — events, findings, cost
    ReportsModule, // E · Reports   — reports
  ],
})
export class AppModule {}
