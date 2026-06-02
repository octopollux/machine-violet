import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: {
      "@machine-violet/shared": resolve(__dirname, "../shared/src"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      // AddContentPhase imports engine-only modules (content pipeline,
      // config/systems) that haven't been migrated into client-ink yet, so
      // its test can't run here. Re-enable once the feature is migrated.
      "src/phases/AddContentPhase.test.tsx",
    ],
  },
});
