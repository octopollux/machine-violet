#!/usr/bin/env node
/**
 * Launch both Campaign Explorer backend (Express) and frontend (Vite)
 * in a single terminal session. Cross-platform.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const SERVER_PORT = process.env.PORT ?? "3999";
const CLIENT_PORT = "5199";

// Start Express API server
const server = spawn("node", ["--import", "tsx/esm", "src/server/index.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: SERVER_PORT },
  shell: true,
});

// Start Vite dev server
const client = spawn("npx", ["vite", "--port", CLIENT_PORT], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  shell: true,
});

// Prefix and relay output
function relay(proc, label) {
  proc.stdout?.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(`[${label}] ${line}`);
    }
  });
  proc.stderr?.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.error(`[${label}] ${line}`);
    }
  });
}

relay(server, "server");
relay(client, "client");

// Print the frontend URI once Vite is ready
client.stdout?.on("data", (data) => {
  const text = data.toString();
  if (text.includes("Local:") || text.includes("localhost")) {
    // Vite prints the URL — also print our own banner
    console.log(`\n  Campaign Explorer UI: http://localhost:${CLIENT_PORT}/\n`);
  }
});

// Clean shutdown
function cleanup() {
  server.kill();
  client.kill();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

server.on("exit", (code) => {
  if (code !== null && code !== 0) console.error(`[server] exited with code ${code}`);
  client.kill();
});

client.on("exit", (code) => {
  if (code !== null && code !== 0) console.error(`[client] exited with code ${code}`);
  server.kill();
});
