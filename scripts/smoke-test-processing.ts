/**
 * Smoke test for the content processing pipeline.
 *
 * Usage: npx tsx scripts/smoke-test-processing.ts
 *
 * Requires:
 * - ANTHROPIC_API_KEY in .env
 * - Cached pages at ~/.machine-violet/ingest/cache/d-d-5e/
 *
 * Runs the full 5-stage pipeline against the cached DMG pages.
 * Uses Haiku via Batch API (~$0.90-1.70).
 */

import "dotenv/config";
import { createClient } from "../packages/engine/src/config/client.js";
import { readFile, writeFile, appendFile, mkdir, stat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileIO } from "../packages/engine/src/agents/scene-manager.js";
import { loadModelConfig } from "../packages/engine/src/config/models.js";
import { runProcessingPipeline } from "../packages/engine/src/content/process.js";

// --- Real FileIO ---
const io: FileIO = {
  readFile: (p: string) => readFile(p, "utf-8"),
  writeFile: (p: string, c: string) => writeFile(p, c, "utf-8"),
  appendFile: (p: string, c: string) => appendFile(p, c, "utf-8"),
  mkdir: (p: string) => mkdir(p, { recursive: true }).then(() => {}),
  exists: async (p: string) => {
    try { await stat(p); return true; } catch { return false; }
  },
  listDir: (p: string) => readdir(p),
};

async function main() {
  loadModelConfig({ reset: true });

  const client = createClient();
  const homeDir = resolve(process.env.USERPROFILE ?? process.env.HOME ?? "~", "Documents", ".machine-violet");
  const projectRoot = resolve(import.meta.dirname, "..");

  console.log("Home dir:", homeDir);
  console.log("Project root:", projectRoot);
  console.log("");

  const collectionSlug = "d-d-5e";
  const jobSlug = "dungeon-master-s-guide-unknown";
  const totalPages = 320;

  console.log(`Processing: ${collectionSlug} / ${jobSlug} (${totalPages} pages)`);
  console.log("This will make real Haiku batch API calls (~$0.90-1.70).");
  console.log("");

  await runProcessingPipeline({
    client,
    io,
    homeDir,
    collectionSlug,
    jobSlug,
    totalPages,
    projectRoot,
    onProgress: (p) => {
      const prefix = `[${p.stage}]`.padEnd(14);
      console.log(`${prefix} ${p.message}${p.detail ? ` — ${p.detail}` : ""}`);
    },
  });

  console.log("");
  console.log("Done! Check output at:");
  console.log(`  ${resolve(homeDir, "systems", collectionSlug)}/`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
