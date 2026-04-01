/**
 * MachineViolet launcher — single-process combined entry point.
 *
 * Default mode: starts Fastify engine server + Ink TUI client in one process.
 * --server mode: headless engine server only (for network hosting).
 *
 * This is the entry point bundled into the SEA binary.
 *
 * Usage:
 *   MachineViolet                     # full game (server + client)
 *   MachineViolet --server            # headless server only
 *   MachineViolet --campaign ID       # auto-start a campaign
 *
 * Environment:
 *   MV_PORT       — HTTP port (default 7200)
 *   MV_HOST       — Bind address (default 127.0.0.1; use 0.0.0.0 for network)
 *   MV_CAMPAIGNS  — Campaign data directory (auto-detected if not set)
 *   MV_PLAYER     — Player name (default "Player")
 *   MV_CAMPAIGN   — Campaign ID to auto-start
 *   ANTHROPIC_API_KEY — Required for the engine
 */
import { join } from "node:path";
import { handleVelopackHook } from "../packages/engine/src/config/velopack-hooks.js";
import { createServer } from "../packages/engine/src/server/server.js";
import { defaultCampaignRoot } from "../packages/engine/src/tools/filesystem/platform.js";
import { configDir } from "../packages/engine/src/utils/paths.js";
import { loadEnv } from "../packages/engine/src/config/first-launch.js";

// --- Velopack lifecycle hooks (Windows install/update/uninstall) ---
// Must run before any server/client startup. Exits the process if a hook fires.
handleVelopackHook();

// --- Load environment ---
loadEnv();

// --- Parse args ---
const serverOnly = process.argv.includes("--server");
let campaign = process.env.MV_CAMPAIGN;
let wsLogPath: string | undefined;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if ((arg === "--campaign" || arg === "-c") && process.argv[i + 1]) {
    campaign = process.argv[++i];
  } else if (arg === "--ws-log" && process.argv[i + 1]) {
    wsLogPath = process.argv[++i];
  } else if (!arg.startsWith("-")) {
    campaign = arg;
  }
}

// --- Server config ---
const port = Number(process.env.MV_PORT) || 7200;
const host = process.env.MV_HOST ?? "127.0.0.1";
const campaignsDir = process.env.MV_CAMPAIGNS ?? join(defaultCampaignRoot(), "campaigns");
const appConfigDir = configDir();

// --- Start engine server ---
const server = await createServer({
  port,
  host,
  campaignsDir,
  configDir: appConfigDir,
});

// Suppress Fastify request logging in launcher mode (player doesn't need it)
if (!serverOnly) {
  server.log.level = "error";
}

// Enable WS event logging if requested
if (wsLogPath) {
  server.sessionManager.setWsLog(wsLogPath);
  console.log(`WS event log: ${wsLogPath}`);
}

try {
  await server.listen({ port, host });
} catch (err) {
  if (serverOnly) {
    console.error("Failed to start server:", err instanceof Error ? err.message : err);
  } else {
    console.error("Engine server failed to start:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
}

if (serverOnly) {
  // --- Headless server mode ---
  console.log(`MachineViolet server listening on ${host}:${port}`);
  console.log(`  Campaigns: ${campaignsDir}`);
} else {
  // --- Full game mode: start TUI client ---
  // Dynamic import so esbuild can tree-shake React/Ink out of --server builds
  // (not critical for SEA size, but keeps the import graph clean)
  const { startClient } = await import("../packages/client-ink/src/start-client.js");

  const { waitUntilExit } = startClient({
    server: `http://127.0.0.1:${port}`,
    player: process.env.MV_PLAYER ?? "Player",
    campaign,
  });

  await waitUntilExit();
  await server.close();
  process.exit(0);
}
