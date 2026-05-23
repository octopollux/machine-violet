import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Contract tests reach into packages/engine/src/* directly. Those modules
    // import from @machine-violet/shared via subpath exports, which need the
    // "source" condition + dev alias to resolve to .ts sources (no dist
    // build is required during test runs). Matches packages/engine/vitest.config.ts.
    conditions: ["source"],
    alias: {
      "@machine-violet/shared": resolve(__dirname, "../../packages/shared/src"),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
