/**
 * Fastify server factory for the Machine Violet engine.
 *
 * Creates an HTTP + WebSocket server that exposes the game engine
 * over REST (commands, turns, settings) and WebSocket (streaming
 * narrative, state snapshots, turn lifecycle events).
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import { campaignRoutes } from "./routes/campaigns.js";
import { sessionRoutes } from "./routes/session.js";
import { dataRoutes } from "./routes/data.js";
import { managementRoutes } from "./routes/management.js";
import { wsHandler } from "./ws.js";
import { SessionManager } from "./session-manager.js";
import { initEngineLog, logEvent, closeEngineLog } from "../context/engine-log.js";
import { isCompiled } from "../utils/paths.js";

export interface ServerConfig {
  /** Port to listen on. Default 7200. */
  port: number;
  /** Host to bind to. Default "127.0.0.1" (localhost-only). */
  host: string;
  /** Root directory containing campaign data. */
  campaignsDir: string;
  /** App config directory (api-keys.json, discord-settings.json, .env). */
  configDir: string;
}

const DEFAULTS: ServerConfig = {
  port: 7200,
  host: "127.0.0.1",
  campaignsDir: "",
  configDir: "",
};

export async function createServer(
  config: Partial<ServerConfig> = {},
): Promise<FastifyInstance> {
  const cfg = { ...DEFAULTS, ...config };

  // Mirror stdout/stderr to .debug/server.log (not in test mode)
  if (process.env.NODE_ENV !== "test" && cfg.campaignsDir) {
    try {
      const logDir = join(dirname(cfg.campaignsDir), ".debug");
      mkdirSync(logDir, { recursive: true });
      const logStream = createWriteStream(join(logDir, "server.log"), { flags: "a" });
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        logStream.write(chunk);
        return (origStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...args);
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        logStream.write(chunk);
        return (origStderrWrite as (...a: unknown[]) => boolean)(chunk, ...args);
      }) as typeof process.stderr.write;
    } catch { /* best-effort */ }
  }

  // --- Engine event log ---
  if (process.env.NODE_ENV !== "test" && cfg.campaignsDir) {
    initEngineLog(cfg.campaignsDir);
    logEvent("server:start", {
      version: process.env.npm_package_version ?? "dev",
      port: cfg.port,
      host: cfg.host,
      campaignsDir: cfg.campaignsDir,
      node: process.version,
      platform: process.platform,
    });
  }

  const server = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: "info" },
  });

  // --- Plugins ---

  await server.register(fastifyCors, { origin: true });
  await server.register(fastifyWebSocket);
  await server.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Machine Violet Engine API",
        description: [
          "# Machine Violet Engine API",
          "",
          "Machine Violet is an agentic AI Dungeon Master that runs any tabletop RPG.",
          "The engine server exposes game logic over REST (this document) and WebSocket",
          "(see `docs/websocket-api.md` in the repository).",
          "",
          "## Stateful Campaign Model",
          "",
          "The server runs **one campaign session at a time**. The typical lifecycle is:",
          "",
          "1. **List campaigns** — `GET /campaigns` returns saved campaigns.",
          "2. **Start a session** — `POST /campaigns/:id/start` (resume) or `POST /campaigns` (new). Returns a `sessionId` and `wsUrl`.",
          "3. **Connect via WebSocket** — open `ws://<host>/session/ws?role=player&player=<name>`. The server immediately pushes a `state:snapshot` event with full game state.",
          "4. **Play** — submit player actions and choice responses with `POST /session/turn/contribute` (set `fromChoice: true` when the contribution comes from a choice modal). The DM narrates via WebSocket `narrative:chunk` / `narrative:complete` events.",
          "5. **End** — `POST /session/end` tears down the session. The server also auto-saves and ends the session after 5 minutes with no player connections.",
          "",
          "Starting a session while one is already active returns **409 Conflict**.",
          "",
          "## Turn System",
          "",
          "Gameplay is organized into turns:",
          "",
          "- The server opens a turn and broadcasts `turn:opened` over WebSocket.",
          "- Players contribute via `POST /session/turn/contribute`.",
          "- **Single-player** (`commitPolicy: \"auto\"`): the turn auto-commits after one contribution.",
          "- **Multi-player** (`commitPolicy: \"all\"`): the turn commits when all active players have contributed, or on explicit `POST /session/turn/commit`.",
          "- The DM processes the turn (streamed via `narrative:chunk` events) and the cycle repeats.",
          "",
          "## Choices",
          "",
          "When the DM or setup agent offers the player a set of options, the server pushes",
          "a `choices:presented` event with the prompt and available choices. The player responds",
          "by sending the selected text as a turn contribution (`POST /session/turn/contribute`",
          "with `fromChoice: true`). The setup agent uses the flag to distinguish a real selection",
          "from a dismissal+free-form response, but the wire path is identical to gameplay.",
          "",
          "## REST vs WebSocket",
          "",
          "| Direction | Channel | Examples |",
          "|-----------|---------|----------|",
          "| Client → Server | REST | Contribute to turn, commit, respond to choices, slash commands |",
          "| Server → Client | WebSocket | Narrative streaming, turn lifecycle, choices, state snapshots |",
          "",
          "All WebSocket communication is **server-to-client only**. Clients never send",
          "messages over the WebSocket — commands go through REST endpoints.",
        ].join("\n"),
        version: "0.1.0",
      },
      servers: [{ url: `http://${cfg.host}:${cfg.port}` }],
      tags: [
        { name: "Campaigns", description: "Campaign listing, creation, and launch" },
        { name: "Session", description: "Gameplay interaction — turns, commands, choices" },
        { name: "Data", description: "Session data — characters, compendium, notes, settings, cost" },
        { name: "Management", description: "AI connections, tiers, campaign ops, Discord settings" },
      ],
    },
  });
  // Scalar API docs — dev only. The plugin serves a static JS file from
  // node_modules which doesn't exist inside a compiled SEA binary.
  if (!isCompiled()) {
    const { default: scalarReference } = await import("@scalar/fastify-api-reference");
    await server.register(scalarReference, {
      routePrefix: "/docs",
      configuration: { title: "Machine Violet API", agent: { disabled: true } },
    });
  }

  // --- Session manager (one active session per process) ---

  const sessionManager = new SessionManager(cfg.campaignsDir);
  server.decorate("sessionManager", sessionManager);
  server.decorate("configDir", cfg.configDir);

  // --- Routes ---

  await server.register(campaignRoutes, { prefix: "/campaigns" });
  await server.register(managementRoutes, { prefix: "/manage" });
  await server.register(sessionRoutes, { prefix: "/session" });
  await server.register(dataRoutes, { prefix: "/session" });
  await server.register(wsHandler, { prefix: "/session" });

  // --- Lifecycle ---

  server.addHook("onClose", async () => {
    await sessionManager.teardown();
    closeEngineLog();
  });

  return server;
}

// Fastify type augmentation for the session manager decorator
declare module "fastify" {
  interface FastifyInstance {
    sessionManager: SessionManager;
    configDir: string;
  }
}
