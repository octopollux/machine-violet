import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@engine-src": resolve(__dirname, "../../packages/client-ink/src"),
    },
  },
  // ink and yoga-layout (transitively pulled via @engine-src/tui/frames) use
  // top-level await, which only es2022+ supports. Both the dev pre-bundler
  // and the production build need the bumped target.
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },
  build: { target: "es2022" },
  server: {
    port: 5198,
    proxy: {
      "/api": {
        target: "http://localhost:3998",
      },
    },
  },
});
