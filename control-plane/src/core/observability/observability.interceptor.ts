import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable } from 'rxjs';
import { trace } from '@opentelemetry/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Metrics } from './metrics.js';

// Global async context for observer-side correlation (docs/component-h-hardening.md
// §6.2). `engagement_id` is bound here on every request so ANY downstream log line
// / child span (BullMQ worker, ingest producer) can read the correlation id from the
// same async context without threading it through every call signature.
export const observabilityStorage =
  new AsyncLocalStorage<{ engagementId: string | undefined }>();

// Read the current request's engagement id from the async context. Intended for
// services that emit logs/spans and want the correlation field without reaching
// into the HTTP request themselves.
export function currentEngagementId(): string | undefined {
  return observabilityStorage.getStore()?.engagementId;
}

// Global observer interceptor (docs/component-h-hardening.md §6). Runs on every
// route AFTER guards (it is an APP_INTERCEPTOR registered like QuotaInterceptor),
// so request params/body are populated. It:
//   - extracts `engagement_id` from either the route param (:id on the engagement
//     routes) or the request body,
//   - sets it as the active OTel span attribute,
//   - binds it into the AsyncLocalStorage so every log line and child span in this
//     request's tree carries it.
// Fail-open by necessity (§3.6): a tracing/metrics failure must never take a route
// down, so all OTel calls are guarded and never throw.
@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  // METRICS is optional so a bare `new ObservabilityInterceptor()` (unit tests)
  // still works; under DI the @Global ObservabilityModule always provides it.
  constructor(
    @Optional() @Inject('METRICS') private readonly metrics?: Metrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const engagementId = this.extract(context);
    const span = trace.getActiveSpan();
    if (span && engagementId) {
      span.setAttribute('engagement.id', engagementId);
      span.setAttribute('engagement_id', engagementId);
    }

    // RED labels: the route PATTERN (not the concrete URL — :id stays a param so
    // cardinality is bounded) + method + final status.
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const route =
      (req as { routeOptions?: { url?: string } }).routeOptions?.url ??
      req?.url ??
      'unknown';
    const method = req?.method ?? 'UNKNOWN';

    // Bind the engagement_id into the async-local context for the WHOLE request
    // lifecycle (not just observable creation): wrap next.handle()'s subscription
    // so every downstream emission — controller execution, service logging, child
    // span creation — observes the store (§6.2). Each subscriber runs within its
    // own run() scope, so concurrent requests never cross-contaminate.
    return new Observable((subscriber) =>
      observabilityStorage.run({ engagementId }, () =>
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          // Metric recording is fail-open (§3.6): a metrics error must never take
          // a route down, so every record is guarded.
          error: (err: unknown) => {
            const code = (err as { status?: number })?.status ?? 500;
            this.record(route, method, String(code), code >= 500);
            subscriber.error(err);
          },
          complete: () => {
            const status = String(reply?.statusCode ?? 200);
            this.record(route, method, status, false);
            subscriber.complete();
          },
        }),
      ),
    );
  }

  private record(
    route: string,
    method: string,
    status: string,
    isError: boolean,
  ): void {
    try {
      this.metrics?.httpRequests.inc({ route, method, status });
      if (isError) this.metrics?.httpErrors.inc({ route });
    } catch {
      // fail-open — visibility only.
    }
  }

  // The ONE identifier every plane already shares (§3.3): engagement_id is the
  // route :id on the lifecycle + ingest + SSE routes, and any POST body that
  // carries it. Extraction handles both shapes so a single trace spans dispatch →
  // provision → attack → ingest regardless of which route opened it.
  private extract(context: ExecutionContext): string | undefined {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (!req) return undefined;

    const params = (req.params ?? {}) as Record<string, string | undefined>;
    if (params.id) return params.id;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body === 'object' && body !== null) {
      if (typeof body.engagementId === 'string') return body.engagementId;
      if (typeof body.engagement_id === 'string') return body.engagement_id;
    }
    return undefined;
  }
}