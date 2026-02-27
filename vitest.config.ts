import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 83,
        branches: 73,
        functions: 82,
        lines: 84,
      },
    },
  },
});
