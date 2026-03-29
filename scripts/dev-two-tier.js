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
 * With no campaign-id, shows a menu of available campaigns.
 *
 * Environment:
 *   MV_CAMPAIGNS  — Campaign data directory (auto-detected if not set)
 *   MV_PORT       — Engine server port (default: 7200)
 *   MV_CAMPAIGN   — Campaign ID (alternative to positional arg)
 *   ANTHROPIC_API_KEY — Required for the engine
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

const port = process.env.MV_PORT || "7200";
const campaignId = process.argv[2] || process.env.MV_CAMPAIGN || "";

console.log(`Starting engine server on port ${port}...`);
if (campaignId) console.log(`  Campaign: ${campaignId}`);
console.log();

// --- Start engine server ---
const serverEnv = {
  ...process.env,
  MV_PORT: port,
  NODE_ENV: "development",
};

const server = spawn(
  process.execPath,
  ["--import", "tsx/esm", join(root, "packages/engine/src/index.ts")],
  { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
);

let serverReady = false;
let shuttingDown = false;
const serverLog = [];

server.stdout.on("data", (data) => {
  const line = data.toString().trim();
  serverLog.push(line);
  if (line.includes("Server listening")) {
    serverReady = true;
  }
});

server.stderr.on("data", (data) => {
  const line = data.toString().trim();
  serverLog.push("[stderr] " + line);
  if (!serverReady) {
    process.stderr.write(data);
  }
});

server.on("exit", (code) => {
  if (shuttingDown) return; // Intentional shutdown — don't print errors
  if (!serverReady) {
    console.error(`Engine server failed to start (exit code ${code}).`);
    console.error("Last output:");
    for (const line of serverLog.slice(-10)) {
      console.error("  " + line);
    }
  } else {
    console.error(`\nEngine server crashed (exit code ${code}). Last output:`);
    for (const line of serverLog.slice(-20)) {
      console.error("  " + line);
    }
  }
  process.exit(code ?? 1);
});

// --- Wait for server to be ready ---
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

// --- Cleanup ---
function cleanup() {
  shuttingDown = true;
  if (!server.killed) {
    server.kill("SIGTERM");
    setTimeout(() => {
      if (!server.killed) server.kill("SIGKILL");
    }, 2000);
  }
}

// --- Main ---
async function main() {
  const ready = await waitForServer();
  if (!ready) {
    console.error("Engine server did not become ready in time.");
    cleanup();
    process.exit(1);
  }

  console.log("Engine server ready. Launching TUI client...\n");

  const clientEnv = {
    ...process.env,
    MV_SERVER: `http://127.0.0.1:${port}`,
    MV_PLAYER: process.env.MV_PLAYER || "Player",
  };
  if (campaignId) clientEnv.MV_CAMPAIGN = campaignId;

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
    if (code !== 0) {
      // Show server logs if client crashed — might be a server-side cause
      console.error(`\nClient exited with code ${code}.`);
      const recentErrors = serverLog.filter(l => l.includes("[stderr]") || l.includes("err")).slice(-10);
      if (recentErrors.length > 0) {
        console.error("Recent server output:");
        for (const line of recentErrors) {
          console.error("  " + line);
        }
      }
    }
    cleanup();
    // Give cleanup a moment before exiting
    setTimeout(() => process.exit(code ?? 0), 500);
  });

  process.on("SIGINT", () => {
    client.kill("SIGINT");
    cleanup();
    setTimeout(() => process.exit(0), 500);
  });

  process.on("SIGTERM", () => {
    client.kill("SIGTERM");
    cleanup();
    setTimeout(() => process.exit(0), 500);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  cleanup();
  process.exit(1);
});
