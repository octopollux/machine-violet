#!/usr/bin/env node
/**
 * Development launcher for the two-tier architecture.
 *
 * Starts the engine server, waits for it to be ready, then launches
 * the Ink TUI client. Cleans up both processes on exit.
 *
 * Usage:
 *   node scripts/dev-two-tier.js [campaign-id]
 *
 * Environment:
 *   MV_CAMPAIGNS  — Campaign data directory (required)
 *   MV_PORT       — Engine server port (default: 7200)
 *   ANTHROPIC_API_KEY — Required for the engine
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

const port = process.env.MV_PORT || "7200";
const campaignsDir = process.env.MV_CAMPAIGNS || "";
const campaignId = process.argv[2] || process.env.MV_CAMPAIGN || "";

if (!campaignsDir) {
  console.error("Error: MV_CAMPAIGNS environment variable is required.");
  console.error("  Set it to your campaigns directory, e.g.:");
  console.error("  $env:MV_CAMPAIGNS = \"$env:APPDATA\\MachineViolet\\campaigns\"");
  process.exit(1);
}

if (!campaignId) {
  console.error("Error: Campaign ID is required.");
  console.error("  Usage: node scripts/dev-two-tier.js <campaign-id>");
  console.error("  Or set MV_CAMPAIGN environment variable.");
  process.exit(1);
}

console.log(`Starting engine server on port ${port}...`);
console.log(`  Campaigns dir: ${campaignsDir}`);
console.log(`  Campaign: ${campaignId}`);
console.log();

// --- Start engine server ---
const serverEnv = {
  ...process.env,
  MV_CAMPAIGNS: campaignsDir,
  MV_PORT: port,
  NODE_ENV: "development",
};

const server = spawn(
  process.execPath,
  ["--import", "tsx/esm", join(root, "packages/engine/src/index.ts")],
  { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
);

let serverReady = false;

server.stdout.on("data", (data) => {
  const line = data.toString().trim();
  if (line.includes("Server listening")) {
    serverReady = true;
  }
  // Don't echo server logs — they'd corrupt the TUI
});

server.stderr.on("data", (data) => {
  if (!serverReady) {
    // Show startup errors
    process.stderr.write(data);
  }
});

server.on("exit", (code) => {
  if (!serverReady) {
    console.error(`Engine server failed to start (exit code ${code}).`);
    process.exit(1);
  }
});

// --- Wait for server to be ready, then launch client ---
async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/campaigns`);
      if (resp.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const ready = await waitForServer();
  if (!ready) {
    console.error("Engine server did not become ready in time.");
    cleanup();
    process.exit(1);
  }

  console.log("Engine server ready. Launching TUI client...\n");

  // --- Start client ---
  const clientEnv = {
    ...process.env,
    MV_SERVER: `http://127.0.0.1:${port}`,
    MV_CAMPAIGN: campaignId,
    MV_PLAYER: process.env.MV_PLAYER || "Player",
  };

  const client = spawn(
    process.execPath,
    [
      "--max-semi-space-size=16",
      "--import", "tsx/esm",
      join(root, "packages/client-ink/src/index.tsx"),
    ],
    { env: clientEnv, stdio: "inherit" },
  );

  client.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  // --- Cleanup on signals ---
  function cleanup() {
    if (!server.killed) {
      server.kill("SIGTERM");
      // Give server a moment to flush state, then force kill
      setTimeout(() => {
        if (!server.killed) server.kill("SIGKILL");
      }, 2000);
    }
  }

  process.on("SIGINT", () => {
    client.kill("SIGINT");
    cleanup();
  });

  process.on("SIGTERM", () => {
    client.kill("SIGTERM");
    cleanup();
  });

  // Windows: handle Ctrl+C via SIGINT (Node translates it)
  if (process.platform === "win32") {
    process.on("SIGHUP", () => {
      client.kill("SIGTERM");
      cleanup();
    });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  server.kill();
  process.exit(1);
});
