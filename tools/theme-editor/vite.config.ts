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
  server: {
    port: 5198,
    proxy: {
      "/api": {
        target: "http://localhost:3998",
      },
    },
  },
});
