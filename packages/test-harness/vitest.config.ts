import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * test-harness unit tests (co-located `src/**​/*.test.ts`). Kept lightweight —
 * the harness's heavy work is the live/replay e2e runners driven by npm scripts,
 * not vitest; this project covers the pure logic (session id/path resolution,
 * golden shaping, …). Mirrors the shared-source alias the sibling projects use so
 * imports that reach @machine-violet/shared resolve to .ts without a dist build.
 */
export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: {
      "@machine-violet/shared": resolve(__dirname, "../../packages/shared/src"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
