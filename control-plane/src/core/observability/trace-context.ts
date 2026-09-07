import { context, propagation, trace, type Context } from '@opentelemetry/api';

// Convert a W3C traceparent string (`00-<trace-id>-<span-id>-<flags>`) back into
// an OTel Context carrying that remote span (docs/component-h-hardening.md §6.2,
// §6.3). Uses the API's built-in W3C propagator (`propagation.extract`), which is
// registered by default on the SDK — no second tracing channel needed, the border
// stays "data, not code". Returns null for a missing/malformed header so the caller
// opens a standalone span instead — the seam stays fail-open.
export function traceparentToContext(
  traceparent: string | undefined,
): Context | null {
  if (!traceparent) return null;
  const carrier = { traceparent };
  const ctx = propagation.extract(context.active(), carrier, {
    get: (c, key) => (c as Record<string, string | undefined>)[key],
    keys: (c) => Object.keys(c as Record<string, unknown>),
  });
  const spanCtx = trace.getSpanContext(ctx);
  if (!spanCtx) return null;
  return ctx;
}