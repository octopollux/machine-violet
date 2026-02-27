import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scanCampaigns } from "./campaign-scanner.js";
import { watchCampaign } from "./watcher.js";
import { sseHandler, broadcast } from "./sse.js";
import { createApiRouter } from "./api.js";
import type { CampaignInfo } from "../shared/protocol.js";
import type { FSWatcher } from "chokidar";

const PORT = parseInt(process.env.PORT ?? "3999", 10);

/** Resolve campaigns directory from CLI args > config.json > platform default. */
async function resolveCampaignsDir(): Promise<string> {
  // CLI arg: --campaigns-dir <path>
  const argIdx = process.argv.indexOf("--campaigns-dir");
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    return resolve(process.argv[argIdx + 1]);
  }

  // Try main app's config.json
  const configPaths = [
    join(process.cwd(), "../../config.json"), // from tools/campaign-explorer/
    join(process.cwd(), "config.json"),        // if run from project root
  ];

  for (const configPath of configPaths) {
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      if (config.campaigns_dir) return resolve(config.campaigns_dir);
    } catch {
      // Try next
    }
  }

  // Platform default
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, "Documents", ".tui-rpg", "campaigns");
}

async function main(): Promise<void> {
  const campaignsDir = await resolveCampaignsDir();
  console.log(`Campaign Explorer — watching: ${campaignsDir}`);

  let campaigns: CampaignInfo[] = await scanCampaigns(campaignsDir);
  const watchers: FSWatcher[] = [];

  const getCampaigns = () => campaigns;
  const getCampaignPath = (slug: string) =>
    campaigns.find((c) => c.slug === slug)?.path;

  // Set up file watchers for each campaign
  for (const campaign of campaigns) {
    const watcher = watchCampaign(campaign.slug, campaign.path, {
      onFileChange: (event) => broadcast(event),
    });
    watchers.push(watcher);
  }

  // Set up Express
  const app = express();
  app.use(cors());

  // SSE endpoint
  app.get("/api/events", sseHandler);

  // REST API
  app.use("/api", createApiRouter(getCampaigns, getCampaignPath));

  // Refresh campaigns endpoint (manual rescan)
  app.post("/api/refresh", async (_req, res) => {
    for (const w of watchers) await w.close();
    watchers.length = 0;

    campaigns = await scanCampaigns(campaignsDir);
    for (const campaign of campaigns) {
      const watcher = watchCampaign(campaign.slug, campaign.path, {
        onFileChange: (event) => broadcast(event),
      });
      watchers.push(watcher);
    }

    res.json({ campaigns: campaigns.length });
  });

  app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
    console.log(`Found ${campaigns.length} campaign(s)`);
    for (const c of campaigns) {
      console.log(`  - ${c.name} (${c.slug})`);
    }
  });
}

main().catch((err) => {
  console.error("Failed to start Campaign Explorer:", err);
  process.exit(1);
});
