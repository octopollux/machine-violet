import express from "express";
import cors from "cors";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { scanCampaigns } from "./campaign-scanner.js";
import { watchCampaign } from "./watcher.js";
import { sseHandler, broadcast, clientCount } from "./sse.js";
import { createApiRouter } from "./api.js";
import type { CampaignInfo } from "../shared/protocol.js";

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
  return join(home, "Documents", ".machine-violet", "campaigns");
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

  // Watch the campaigns parent directory for new/removed campaign folders
  const campaignWatchers = new Map<string, FSWatcher>();
  for (const c of campaigns) campaignWatchers.set(c.slug, watchers[campaigns.indexOf(c)]);

  /** Try to register a new campaign from a directory name. */
  async function tryAddCampaign(dirName: string): Promise<void> {
    if (campaigns.some((c) => c.slug === dirName)) return;
    const dirPath = join(campaignsDir, dirName);
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) return;
      const raw = await readFile(join(dirPath, "config.json"), "utf-8");
      const config = JSON.parse(raw);
      const info: CampaignInfo = {
        slug: basename(dirPath),
        name: config.name ?? basename(dirPath),
        path: dirPath,
      };
      campaigns.push(info);
      const watcher = watchCampaign(info.slug, info.path, {
        onFileChange: (event) => broadcast(event),
      });
      watchers.push(watcher);
      campaignWatchers.set(info.slug, watcher);
      console.log(`[campaigns] added: ${info.name} (${info.slug})`);
      broadcast({ type: "campaign-change", campaignSlug: info.slug, changeType: "add" });
    } catch {
      // Not a valid campaign yet (no config.json, etc.) — ignore
    }
  }

  const parentWatcher = watch(campaignsDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    usePolling: process.platform === "win32",
    interval: 1000,
    ignored: (path: string) => {
      const b = path.split(/[/\\]/).pop() ?? "";
      return b.startsWith(".") || b === "node_modules";
    },
  });

  // A new file (e.g. config.json) or directory appearing may indicate a new campaign
  parentWatcher.on("addDir", (_path) => {
    const dirName = basename(_path);
    if (_path === campaignsDir) return; // chokidar fires for the root itself
    tryAddCampaign(dirName);
  });
  parentWatcher.on("add", (filePath) => {
    // config.json appearing inside a subdir means a campaign just became valid
    if (basename(filePath) === "config.json") {
      const dirName = basename(join(filePath, ".."));
      tryAddCampaign(dirName);
    }
  });
  parentWatcher.on("unlinkDir", (dirPath) => {
    const slug = basename(dirPath);
    const idx = campaigns.findIndex((c) => c.slug === slug);
    if (idx === -1) return;
    campaigns.splice(idx, 1);
    const w = campaignWatchers.get(slug);
    if (w) { w.close(); campaignWatchers.delete(slug); }
    const wIdx = watchers.indexOf(w!);
    if (wIdx !== -1) watchers.splice(wIdx, 1);
    console.log(`[campaigns] removed: ${slug}`);
    broadcast({ type: "campaign-change", campaignSlug: slug, changeType: "remove" });
  });

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

  // --- Debug endpoints (remove later) ---
  app.get("/api/debug/status", (_req, res) => {
    res.json({
      sseClients: clientCount(),
      campaigns: campaigns.length,
      watchers: watchers.length,
    });
  });

  app.get("/api/debug/ping", (_req, res) => {
    const event = {
      type: "file-change" as const,
      campaignSlug: campaigns[0]?.slug ?? "test",
      relativePath: "_debug_ping",
      category: "other" as const,
      changeType: "change" as const,
    };
    broadcast(event);
    res.json({ sent: true, clients: clientCount() });
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
