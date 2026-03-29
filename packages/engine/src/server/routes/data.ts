/**
 * Session data routes — read-only endpoints for client-driven modals.
 *
 * These serve data that the client fetches on demand (character sheets,
 * compendium, player notes, settings). The client decides when to show
 * these — the server just provides the data.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { campaignPaths } from "../../tools/filesystem/scaffold.js";

export const dataRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // Require active session
  server.addHook("preHandler", async (_request, reply) => {
    if (!server.sessionManager.isActive) {
      return reply.status(400).send({ error: "No active session." });
    }
  });

  /** Get a character sheet by name. */
  server.get<{ Params: { name: string } }>("/character/:name", async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    if (!engine) return reply.status(400).send({ error: "No active engine." });

    const gs = server.sessionManager.getGameState();
    if (!gs) return reply.status(400).send({ error: "No game state." });

    const fileIO = engine.getSceneManager().getFileIO();
    const name = request.params.name;

    // Try characters/<name>.md first, then players/<name>.md
    const paths = campaignPaths(gs.campaignRoot);
    for (const pathFn of [paths.character, paths.player]) {
      const path = pathFn(name);
      try {
        if (await fileIO.exists(path)) {
          const content = await fileIO.readFile(path);
          return { name, content };
        }
      } catch { /* try next */ }
    }

    return reply.status(404).send({ error: `Character "${name}" not found.` });
  });

  /** Get the campaign compendium. */
  server.get("/compendium", async (_request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    const fileIO = engine.getSceneManager().getFileIO();
    const path = campaignPaths(gs.campaignRoot).compendium;

    try {
      const raw = await fileIO.readFile(path);
      const data = JSON.parse(raw);
      return { data };
    } catch {
      // Return empty compendium if file doesn't exist
      return {
        data: {
          version: 1,
          lastUpdatedScene: 0,
          characters: [],
          places: [],
          storyline: [],
          lore: [],
          objectives: [],
        },
      };
    }
  });

  /** Get player notes. */
  server.get("/notes", async (_request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    const fileIO = engine.getSceneManager().getFileIO();
    const path = campaignPaths(gs.campaignRoot).playerNotes;

    try {
      const content = await fileIO.readFile(path);
      return { content };
    } catch {
      return { content: "" };
    }
  });

  /** Save player notes. */
  server.put<{ Body: { content: string } }>("/notes", async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    const fileIO = engine.getSceneManager().getFileIO();
    const path = campaignPaths(gs.campaignRoot).playerNotes;
    const { content } = request.body ?? {};

    try {
      await fileIO.writeFile(path, content ?? "");
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to save notes: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  /** Get campaign settings. */
  server.get("/settings", async (_request, reply) => {
    const gs = server.sessionManager.getGameState();
    if (!gs) return reply.status(400).send({ error: "No game state." });
    return { config: gs.config };
  });

  /** Patch campaign settings. */
  server.patch<{ Body: Record<string, unknown> }>("/settings", async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    // Apply patch to in-memory config
    const patch = request.body ?? {};
    Object.assign(gs.config, patch);

    // Persist to disk
    const fileIO = engine.getSceneManager().getFileIO();
    const path = campaignPaths(gs.campaignRoot).config;
    try {
      await fileIO.writeFile(path, JSON.stringify(gs.config, null, 2));
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to save settings: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  /** Get token cost breakdown. */
  server.get("/cost", async () => {
    const ct = server.sessionManager.getCostTracker();
    if (!ct) return { breakdown: null, formatted: "" };

    return {
      breakdown: ct.getBreakdown(),
      formatted: ct.formatTokens(),
    };
  });
};
