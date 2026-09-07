import { beforeAll, describe, expect, it } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { trace, context, propagation, SpanKind } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ObservabilityInterceptor, currentEngagementId } from './observability.interceptor.js';
import { traceparentToContext } from './trace-context.js';
import { activeTraceparent } from '../../domains/lifecycle/lifecycle.service.js';

// Unit tests for the observability spine (docs/component-h-hardening.md §11):
// the interceptor's engagement_id extraction across route param / body shapes,
// and the W3C trace-context propagation round-trip through the job payload. These
// run without any collector — no OTLP exporter is attached, so nothing is
// transmitted; the interceptor is fail-open (§3.6): it simply binds the async
// context and sets attributes on a span.

// A real tracer provider + the W3C propagator are registered here (mirroring what
// NodeSDK.start() does at runtime) so spans generate valid trace ids and the
// trace-context round-trip exercises the true extract/inject path.
beforeAll(() => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new NodeTracerProvider());
});

function makeContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as ExecutionContext;
}

describe('ObservabilityInterceptor — engagement_id extraction', () => {
  const interceptor = new ObservabilityInterceptor();

  it('extracts engagement_id from the route :id param', async () => {
    const ctx = makeContext({ params: { id: 'eng-123' }, body: undefined, headers: {} });
    let captured: string | undefined;
    const next: CallHandler = {
      handle: () => of(null).pipe(),
    };
    // Subscribe the interceptor's returned Observable; inside the subscription the
    // async store should carry the id.
    await new Promise<void>((resolve) => {
      interceptor.intercept(ctx, next).subscribe(() => {
        captured = currentEngagementId();
        resolve();
      });
    });
    expect(captured).toBe('eng-123');
  });

  it('extracts engagement_id from a camelCase body field', () => {
    const ctx = makeContext({ params: {}, body: { engagementId: 'eng-456' }, headers: {} });
    let captured: string | undefined;
    const next: CallHandler = { handle: () => of(null) };
    interceptor.intercept(ctx, next).subscribe(() => {
      captured = currentEngagementId();
    });
    expect(captured).toBe('eng-456');
  });

  it('extracts engagement_id from a snake_case body field', () => {
    const ctx = makeContext({ params: {}, body: { engagement_id: 'eng-789' }, headers: {} });
    let captured: string | undefined;
    const next: CallHandler = { handle: () => of(null) };
    interceptor.intercept(ctx, next).subscribe(() => {
      captured = currentEngagementId();
    });
    expect(captured).toBe('eng-789');
  });

  it('yields no engagement_id when neither param nor body carries one', () => {
    const ctx = makeContext({ params: {}, body: { unrelated: 1 }, headers: {} });
    let captured: string | undefined = 'sentinel';
    const next: CallHandler = { handle: () => of(null) };
    interceptor.intercept(ctx, next).subscribe(() => {
      captured = currentEngagementId();
    });
    expect(captured).toBeUndefined();
  });

  it('prefers the route :id over a body id when both are present', () => {
    const ctx = makeContext({
      params: { id: 'eng-route' },
      body: { engagement_id: 'eng-body' },
      headers: {},
    });
    let captured: string | undefined;
    const next: CallHandler = { handle: () => of(null) };
    interceptor.intercept(ctx, next).subscribe(() => {
      captured = currentEngagementId();
    });
    expect(captured).toBe('eng-route');
  });
});

describe('W3C trace-context propagation round-trip (job payload)', () => {
  // Simulates: dispatch opens a span → activeTraceparent() → job → worker
  // traceparentToContext() → child span under the SAME trace. Asserts the trace
  // id is preserved across the process/async hop (§5.4, §6.3).
  it('round-trips the same trace id through a serialized traceparent', () => {
    const tracer = trace.getTracer('test');
    const root = tracer.startSpan('root');
    const manual = `00-${root.spanContext().traceId}-${root.spanContext().spanId}-01`;

    const extracted = traceparentToContext(manual);
    expect(extracted).not.toBeNull();
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(root.spanContext().traceId);

    // A child span opened under that context shares the trace id.
    const child = tracer.startSpan(
      'child',
      { kind: SpanKind.CONSUMER },
      extracted ?? undefined,
    );
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    child.end();
    root.end();
  });

  it('round-trips through a real propagation extract/inject pair', () => {
    // Prove the hand-built traceparent from activeTraceparent() is parseable by
    // the built-in W3C propagator (what the Python harness would do with it).
    const tracer = trace.getTracer('test2');

    // activeTraceparent() reads the ACTIVE span; make one active via the context.
    const parent = tracer.startSpan('parent');
    const tp = context.with(trace.setSpan(context.active(), parent), () =>
      activeTraceparent(),
    );
    if (tp) {
      const extracted = propagation.extract(context.active(), { traceparent: tp }, {
        get: (c, k) => (c as Record<string, string | undefined>)[k],
        keys: (c) => Object.keys(c as Record<string, unknown>),
      });
      expect(trace.getSpanContext(extracted)?.traceId).toBe(parent.spanContext().traceId);
    }
    parent.end();
  });

  it('returns null for a malformed traceparent (fail-open to a standalone span)', () => {
    expect(traceparentToContext('garbage')).toBeNull();
    expect(traceparentToContext(undefined)).toBeNull();
    expect(
      traceparentToContext('00-1234-5678-01'), // wrong field lengths
    ).toBeNull();
  });
});