/**
 * Fastify server factory for the Machine Violet engine.
 *
 * Creates an HTTP + WebSocket server that exposes the game engine
 * over REST (commands, turns, settings) and WebSocket (streaming
 * narrative, state snapshots, turn lifecycle events).
 */
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import { campaignRoutes } from "./routes/campaigns.js";
import { sessionRoutes } from "./routes/session.js";
import { wsHandler } from "./ws.js";
import { SessionManager } from "./session-manager.js";

export interface ServerConfig {
  /** Port to listen on. Default 7200. */
  port: number;
  /** Host to bind to. Default "127.0.0.1" (localhost-only). */
  host: string;
  /** Root directory containing campaign data. */
  campaignsDir: string;
}

const DEFAULTS: ServerConfig = {
  port: 7200,
  host: "127.0.0.1",
  campaignsDir: "",
};

export async function createServer(
  config: Partial<ServerConfig> = {},
): Promise<FastifyInstance> {
  const cfg = { ...DEFAULTS, ...config };

  const server = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: "info" },
  });

  // --- Plugins ---

  await server.register(fastifyCors, { origin: true });
  await server.register(fastifyWebSocket);

  // --- Session manager (one active session per process) ---

  const sessionManager = new SessionManager(cfg.campaignsDir);
  server.decorate("sessionManager", sessionManager);

  // --- Routes ---

  await server.register(campaignRoutes, { prefix: "/campaigns" });
  await server.register(sessionRoutes, { prefix: "/session" });
  await server.register(wsHandler, { prefix: "/session" });

  // --- Lifecycle ---

  server.addHook("onClose", async () => {
    await sessionManager.teardown();
  });

  return server;
}

// Fastify type augmentation for the session manager decorator
declare module "fastify" {
  interface FastifyInstance {
    sessionManager: SessionManager;
  }
}
