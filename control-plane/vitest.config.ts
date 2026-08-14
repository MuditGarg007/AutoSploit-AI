import { defineConfig } from 'vitest/config';

// Real Postgres/Redis via Testcontainers in CI, not mocks (docs/control-plane.md §9.1).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
  },
});
