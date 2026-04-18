#!/usr/bin/env node
/**
 * Launch both Theme Editor backend (Express) and frontend (Vite)
 * in a single terminal session. Cross-platform.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Ports are pinned to match the Vite proxy in vite.config.ts — both must
// change together. If you need to run the backend standalone on a different
// port, invoke src/server/index.ts directly with PORT set.
const SERVER_PORT = "3998";
const CLIENT_PORT = "5198";

const server = spawn("node", ["--import", "tsx/esm", "src/server/index.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: SERVER_PORT },
  shell: true,
});

const client = spawn("npx", ["vite", "--port", CLIENT_PORT], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  shell: true,
});

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

client.stdout?.on("data", (data) => {
  const text = data.toString();
  if (text.includes("Local:") || text.includes("localhost")) {
    console.log(`\n  Theme Editor UI: http://localhost:${CLIENT_PORT}/\n`);
  }
});

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
