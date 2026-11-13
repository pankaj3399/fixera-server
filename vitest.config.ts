import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    hookTimeout: 30000,
    // Real-Mongo integration tests run in parallel with each other; under full
    // suite load the 5 s default timed out tests mid-flight (before their
    // finally blocks restored spies), cascading into unrelated failures.
    testTimeout: 30000,
    setupFiles: ["src/tests/setup/providerIsolation.ts"],
  },
});
