import { defineConfig } from 'vitest/config';

// Real Postgres/Redis via Testcontainers in CI, not mocks (docs/control-plane.md §9.1).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Every spec boots real containers (Postgres/Redis/Vault/Redpanda/Connect).
    // Run them serially: parallel execution starves the beforeAll hooks (10s
    // default) and the Connect wait strategy (60s) when 9 suites pull images +
    // boot JVMs at once. ~2 min for the two heavy telemetry specs either way.
    fileParallelism: false,
  },
});
