/**
 * @machine-violet/engine — entry point.
 *
 * Starts the Fastify HTTP/WS server on localhost.
 * Configure via environment variables:
 *   MV_PORT         — HTTP port (default 7200)
 *   MV_HOST         — Bind address (default 127.0.0.1, localhost-only)
 *   MV_CAMPAIGNS    — Campaign data directory (auto-detected if not set)
 */
import { join } from "node:path";
import { createServer } from "./server/server.js";
import { defaultCampaignRoot } from "./tools/filesystem/platform.js";
import { configDir } from "./utils/paths.js";
import { loadEnv } from "./config/first-launch.js";

// Load .env for API key
loadEnv();

const port = Number(process.env.MV_PORT) || 7200;
const host = process.env.MV_HOST ?? "127.0.0.1";

// Auto-detect campaigns dir: MV_CAMPAIGNS env > platform default
const campaignsDir = process.env.MV_CAMPAIGNS ?? join(defaultCampaignRoot(), "campaigns");
const appConfigDir = configDir();

async function main(): Promise<void> {
  const server = await createServer({ port, host, campaignsDir, configDir: appConfigDir });

  try {
    await server.listen({ port, host });
    server.log.info({ campaignsDir }, "Campaigns directory");
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
