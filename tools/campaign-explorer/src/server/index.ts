import express from "express";
import cors from "cors";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { scanCampaigns } from "./campaign-scanner.js";
import { watchCampaign, watchMachineDir } from "./watcher.js";
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
  const campaignWatchers = new Map<string, FSWatcher>();

  const getCampaigns = () => campaigns;
  const getCampaignPath = (slug: string) =>
    campaigns.find((c) => c.slug === slug)?.path;

  // Resolve machine-scope directories (siblings of campaigns dir)
  const machineRoot = dirname(campaignsDir);
  const machineDebugDir = join(machineRoot, ".debug");
  const machinePlayersDir = join(machineRoot, "players");
  const machineDebugAvailable = existsSync(machineDebugDir);
  const machinePlayersAvailable = existsSync(machinePlayersDir);
  const getMachineDir = () => machineDebugAvailable ? machineDebugDir : null;
  let machineWatcher: FSWatcher | null = null;
  let machinePlayersWatcher: FSWatcher | null = null;

  if (machineDebugAvailable) {
    console.log(`Machine-scope debug dir: ${machineDebugDir}`);
    machineWatcher = watchMachineDir(machineDebugDir, {
      onFileChange: (event) => broadcast(event),
    });
  } else {
    console.log(`Machine-scope debug dir not found: ${machineDebugDir}`);
  }

  if (machinePlayersAvailable) {
    console.log(`Machine-scope players dir: ${machinePlayersDir}`);
    machinePlayersWatcher = watchMachineDir(machinePlayersDir, {
      onFileChange: (event) => broadcast({
        ...event,
        relativePath: `players/${event.relativePath}`,
        category: "players",
      }),
    });
  }

  // Set up file watchers for each campaign
  for (const campaign of campaigns) {
    const watcher = watchCampaign(campaign.slug, campaign.path, {
      onFileChange: (event) => broadcast(event),
    });
    campaignWatchers.set(campaign.slug, watcher);
  }

  /** Try to register a new campaign from a directory name. */
  async function tryAddCampaign(dirName: string): Promise<void> {
    if (campaigns.some((c) => c.slug === dirName)) return;
    const dirPath = join(campaignsDir, dirName);
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) return;

      let info: CampaignInfo;
      if (dirName === "__setup__") {
        // __setup__ is a temp dir used during campaign creation — no config.json
        info = { slug: "__setup__", name: "Setup (temp)", path: dirPath };
      } else {
        const raw = await readFile(join(dirPath, "config.json"), "utf-8");
        const config = JSON.parse(raw);
        info = {
          slug: basename(dirPath),
          name: config.name ?? basename(dirPath),
          path: dirPath,
        };
      }
      campaigns.push(info);
      const watcher = watchCampaign(info.slug, info.path, {
        onFileChange: (event) => broadcast(event),
      });
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
    console.log(`[campaigns] removed: ${slug}`);
    broadcast({ type: "campaign-change", campaignSlug: slug, changeType: "remove" });
  });

  // Set up Express
  const app = express();
  app.use(cors());

  // SSE endpoint
  app.get("/api/events", sseHandler);

  // REST API
  app.use("/api", createApiRouter(getCampaigns, getCampaignPath, getMachineDir));

  // Refresh campaigns endpoint (manual rescan)
  app.post("/api/refresh", async (_req, res) => {
    for (const w of campaignWatchers.values()) await w.close();
    campaignWatchers.clear();

    campaigns = await scanCampaigns(campaignsDir);
    for (const campaign of campaigns) {
      const watcher = watchCampaign(campaign.slug, campaign.path, {
        onFileChange: (event) => broadcast(event),
      });
      campaignWatchers.set(campaign.slug, watcher);
    }

    res.json({ campaigns: campaigns.length });
  });

  // --- Debug endpoints (remove later) ---
  app.get("/api/debug/status", (_req, res) => {
    res.json({
      sseClients: clientCount(),
      campaigns: campaigns.length,
      watchers: campaignWatchers.size + (machineWatcher ? 1 : 0),
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
