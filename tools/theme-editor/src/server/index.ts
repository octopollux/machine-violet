import express from "express";
import cors from "cors";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { AssetsResponse, ThemeAssetPayload } from "../shared/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3998", 10);

/** Absolute path to the built-in theme assets directory. */
const ASSETS_DIR = resolve(__dirname, "../../../../packages/client-ink/src/tui/themes/assets");

async function loadAssets(extension: string): Promise<ThemeAssetPayload[]> {
  const entries = await readdir(ASSETS_DIR);
  const matches = entries.filter((e) => e.endsWith(extension));
  const payloads: ThemeAssetPayload[] = [];
  for (const filename of matches) {
    const content = await readFile(join(ASSETS_DIR, filename), "utf-8");
    payloads.push({ name: filename.slice(0, -extension.length), content });
  }
  return payloads.sort((a, b) => a.name.localeCompare(b.name));
}

async function main(): Promise<void> {
  const app = express();
  app.use(cors());

  app.get("/api/assets", async (_req, res) => {
    try {
      const [themes, playerFrames] = await Promise.all([
        loadAssets(".theme"),
        loadAssets(".player-frame"),
      ]);
      const response: AssetsResponse = { themes, playerFrames };
      res.json(response);
    } catch (err) {
      console.error("Failed to list assets:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`Theme Editor API listening on http://localhost:${PORT}`);
    console.log(`Assets dir: ${ASSETS_DIR}`);
  });
}

main().catch((err) => {
  console.error("Failed to start Theme Editor:", err);
  process.exit(1);
});
