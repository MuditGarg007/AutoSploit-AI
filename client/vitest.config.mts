import { defineConfig } from "vitest/config";

// The pure core (lib/events reduceEvent, lib/format) has no DOM or network
// dependency, so the default node environment is all these tests need.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
