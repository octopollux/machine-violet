import { defineConfig } from "vitest/config";

// Root vitest config — only covers unmigrated src/ code (content pipeline, services).
// Main test suites live in packages/engine and packages/client-ink.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
