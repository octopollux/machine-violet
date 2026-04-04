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
    include: ["src/**/*.test.{ts,tsx}"],
    env: { NODE_ENV: "test" },
  },
});
