import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { QuotaService } from './quota.service.js';
import { ENFORCE_QUOTA_KEY } from './enforce-quota.decorator.js';
import type { AuthenticatedUser } from '../guards/session.guard.js';
import type { Metrics } from '../observability/metrics.js';

// Global quota gate (docs/component-q-quota.md §3.3, §12). Registered as an
// APP_INTERCEPTOR, so it runs on EVERY route — but it only acts on routes marked
// @EnforceQuota() (the one dispatch route). It runs AFTER route guards
// (SessionGuard), so request.user is populated by the time it reads it. Throwing
// before next.handle() short-circuits the controller: no engagement row is
// written, no BullMQ job enqueued (§2, §13 exit gate).
//
// Interceptor (not a global Guard) on purpose: a global Guard would run BEFORE
// SessionGuard and see an empty request.user (§3.3). Async intercept is a
// supported Nest pattern — the awaited quota decision resolves before the
// controller's stream is subscribed.
@Injectable()
export class QuotaInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(QuotaService) private readonly quota: QuotaService,
    // Optional so the interceptor works without the @Global metrics provider
    // (unit construction); under DI it is always present.
    @Optional() @Inject('METRICS') private readonly metrics?: Metrics,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const enforce = this.reflector.getAllAndOverride<boolean>(ENFORCE_QUOTA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!enforce) return next.handle();

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const user = (req as FastifyRequest & { user?: AuthenticatedUser }).user;
    if (!user) {
      // Marked route without SessionGuard would be a wiring bug; fail safe to the
      // route's own behavior rather than inventing a 401 here.
      return next.handle();
    }

    // Over any enabled cap → throws 429 here, before the controller runs. The
    // Redis-derived caps already fail open inside QuotaService (§3.5) when the
    // meter is unreachable (or fail closed to a meter_unavailable 429 when
    // QUOTA_FAIL_OPEN=false); the concurrency read goes to Postgres, so if C's
    // DB is down, dispatch would be failing for other reasons anyway.
    try {
      await this.quota.assertUnderCap(user.id);
    } catch (err) {
      // Count the rejection by cap reason (spend|findings|concurrency|
      // meter_unavailable) before rethrowing the 429. Fail-open on a metrics
      // error — never mask the real rejection.
      try {
        const body = (err as { getResponse?: () => unknown })?.getResponse?.();
        const reason =
          (body as { reason?: string })?.reason ?? 'quota';
        this.metrics?.dispatchRejections.inc({ reason });
      } catch {
        // visibility only
      }
      throw err;
    }
    return next.handle();
  }
}
