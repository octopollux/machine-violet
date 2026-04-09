import { defineConfig } from "vitest/config";

/**
 * Root vitest config — workspace mode.
 *
 * Runs engine and client-ink test suites in a single vitest process,
 * sharing the transform cache across packages and reducing total CPU.
 * Each project uses its own vitest.config.ts for resolve aliases,
 * include/exclude patterns, and environment settings.
 */
export default defineConfig({
  test: {
    projects: [
      "packages/engine",
      "packages/client-ink",
    ],
  },
});
