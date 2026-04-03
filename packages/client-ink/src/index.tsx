#!/usr/bin/env node
/**
 * @machine-violet/client-ink entry point.
 *
 * Starts the Ink TUI client, connecting to an engine server.
 *
 * Usage:
 *   node dist/index.js [--server URL] [--player NAME] [--campaign ID]
 *
 * Environment variables:
 *   MV_SERVER   — Engine server URL (default: http://127.0.0.1:7200)
 *   MV_PLAYER   — Player name (default: "Player")
 *   MV_CAMPAIGN — Campaign ID to auto-start
 */
import { startClient } from "./start-client.js";

// --- Parse args ---
function parseArgs(): { server: string; player: string; campaign?: string; agentPort?: number } {
  const args = process.argv.slice(2);
  let server = process.env.MV_SERVER ?? "http://127.0.0.1:7200";
  let player = process.env.MV_PLAYER ?? "Player";
  let campaign = process.env.MV_CAMPAIGN;
  let agentPort: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--server" || args[i] === "-s") && args[i + 1]) {
      server = args[++i];
    } else if ((args[i] === "--player" || args[i] === "-p") && args[i + 1]) {
      player = args[++i];
    } else if ((args[i] === "--campaign" || args[i] === "-c") && args[i + 1]) {
      campaign = args[++i];
    } else if (args[i] === "--agent-port" && args[i + 1]) {
      agentPort = Number(args[++i]);
    } else if (!args[i].startsWith("-")) {
      // Positional arg = campaign ID
      campaign = args[i];
    }
  }
  if (!agentPort && process.env.MV_AGENT_PORT) {
    agentPort = Number(process.env.MV_AGENT_PORT);
  }

  return { server, player, campaign, agentPort };
}

const { server, player, campaign, agentPort } = parseArgs();
const { waitUntilExit } = startClient({ server, player, campaign, agentPort });
await waitUntilExit();
