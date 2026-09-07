import { Counter, Gauge } from 'prom-client';

// DI token for the prom-client registry (docs/component-h-hardening.md §6). Kept in
// its own file so the module, controller, and any service that registers metrics
// share the same symbol WITHOUT a circular import between the module and its
// controller/consumers.
export const PROMETHEUS_REGISTRY = Symbol('PROMETHEUS_REGISTRY');

// Named counters the plan's RED lens asks for (docs/component-h-hardening.md §6.1):
// requests per route, transport errors, and dispatch rejections (Q's 429s). Each is
// labeled by outcome so a dashboard can slice by status. Consumers may register
// additional collectors against the same registry via the injected token.
export interface Metrics {
  httpRequests: Counter;
  httpErrors: Counter;
  dispatchRejections: Counter;
  queueDepth: Gauge;
  ingestAccepted: Counter;
}