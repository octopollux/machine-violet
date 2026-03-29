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
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

// --- Parse args ---
function parseArgs(): { server: string; player: string; campaign?: string } {
  const args = process.argv.slice(2);
  let server = process.env.MV_SERVER ?? "http://127.0.0.1:7200";
  let player = process.env.MV_PLAYER ?? "Player";
  let campaign = process.env.MV_CAMPAIGN;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--server" || args[i] === "-s") && args[i + 1]) {
      server = args[++i];
    } else if ((args[i] === "--player" || args[i] === "-p") && args[i + 1]) {
      player = args[++i];
    } else if ((args[i] === "--campaign" || args[i] === "-c") && args[i + 1]) {
      campaign = args[++i];
    } else if (!args[i].startsWith("-")) {
      // Positional arg = campaign ID
      campaign = args[i];
    }
  }

  return { server, player, campaign };
}

const { server, player, campaign } = parseArgs();

const { unmount, waitUntilExit } = render(
  <App serverUrl={server} playerId={player} campaignId={campaign} />,
  { exitOnCtrlC: true },
);

// Graceful shutdown
process.on("SIGINT", () => {
  unmount();
});

waitUntilExit().then(() => {
  process.exit(0);
});
