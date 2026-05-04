/**
 * Session data routes — read-only endpoints for client-driven modals.
 *
 * These serve data that the client fetches on demand (character sheets,
 * compendium, player notes, settings). The client decides when to show
 * these — the server just provides the data.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  NameParams, CharacterResponse, CompendiumResponse,
  NotesResponse, NotesUpdateRequest, OkResponse,
  SettingsResponse, SettingsPatch, CostResponse, ErrorResponse,
  TranscriptSaveRequest, TranscriptSaveResponse,
  DiagnosticsResponse,
} from "@machine-violet/shared";
import { dirname } from "node:path";
import { campaignPaths, machinePaths } from "../../tools/filesystem/scaffold.js";
import { createArchiveFileIO } from "../fileio.js";
import { collectDiagnostics } from "../diagnostics.js";

export const dataRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // Require active session
  server.addHook("preHandler", async (_request, reply) => {
    if (!server.sessionManager.isActive) {
      return reply.status(400).send({ error: "No active session." });
    }
  });

  /** Get a character sheet by name. */
  server.get("/character/:name", {
    schema: {
      tags: ["Data"],
      params: NameParams,
      response: {
        200: CharacterResponse,
        400: ErrorResponse,
        404: ErrorResponse,
      },
    },
  }, async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    if (!engine) return reply.status(400).send({ error: "No active engine." });

    const gs = server.sessionManager.getGameState();
    if (!gs) return reply.status(400).send({ error: "No game state." });

    const fileIO = engine.getSceneManager().getFileIO();
    const name = (request.params as { name: string }).name;

    // Try characters/<name>.md first, then players/<name>.md
    const paths = campaignPaths(gs.campaignRoot);
    const mPaths = machinePaths(gs.homeDir);
    for (const pathFn of [paths.character, mPaths.player]) {
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
  server.get("/compendium", {
    schema: {
      tags: ["Data"],
      response: { 200: CompendiumResponse, 400: ErrorResponse },
    },
  }, async (_request, reply) => {
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
          items: [],
          storyline: [],
          lore: [],
          objectives: [],
        },
      };
    }
  });

  /** Get player notes. */
  server.get("/notes", {
    schema: {
      tags: ["Data"],
      response: { 200: NotesResponse, 400: ErrorResponse },
    },
  }, async (_request, reply) => {
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
  server.put("/notes", {
    schema: {
      tags: ["Data"],
      body: NotesUpdateRequest,
      response: { 200: OkResponse, 400: ErrorResponse, 500: ErrorResponse },
    },
  }, async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    const fileIO = engine.getSceneManager().getFileIO();
    const path = campaignPaths(gs.campaignRoot).playerNotes;
    const { content } = (request.body as { content: string }) ?? {};

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
  server.get("/settings", {
    schema: {
      tags: ["Data"],
      response: { 200: SettingsResponse, 400: ErrorResponse },
    },
  }, async (_request, reply) => {
    const gs = server.sessionManager.getGameState();
    if (!gs) return reply.status(400).send({ error: "No game state." });
    return { config: gs.config };
  });

  /** Patch campaign settings. */
  server.patch("/settings", {
    schema: {
      tags: ["Data"],
      body: SettingsPatch,
      response: { 200: OkResponse, 400: ErrorResponse, 500: ErrorResponse },
    },
  }, async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    // Apply patch to in-memory config
    const patch = (request.body as Record<string, unknown>) ?? {};
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

  /** Save HTML transcript to campaign root. */
  server.put("/transcript", {
    schema: {
      tags: ["Data"],
      body: TranscriptSaveRequest,
      response: { 200: TranscriptSaveResponse, 400: ErrorResponse, 500: ErrorResponse },
    },
  }, async (request, reply) => {
    const engine = server.sessionManager.getEngine();
    const gs = server.sessionManager.getGameState();
    if (!engine || !gs) return reply.status(400).send({ error: "No active engine." });

    const { join } = await import("node:path");
    const filePath = join(gs.campaignRoot, "game-transcript.html");
    const { html } = (request.body as { html: string }) ?? {};

    try {
      const fileIO = engine.getSceneManager().getFileIO();
      await fileIO.writeFile(filePath, html ?? "");
      return { ok: true, path: filePath };
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to save transcript: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  /** Collect a diagnostics bundle (campaign + .debug → zip) and return its path. */
  server.put("/diagnostics", {
    schema: {
      tags: ["Data"],
      response: { 200: DiagnosticsResponse, 400: ErrorResponse, 500: ErrorResponse },
    },
  }, async (_request, reply) => {
    const gs = server.sessionManager.getGameState();
    if (!gs) return reply.status(400).send({ error: "No game state." });

    const homeDir = dirname(server.sessionManager.getCampaignsDir());
    const io = createArchiveFileIO();
    const result = await collectDiagnostics(gs.campaignRoot, homeDir, io);
    if (!result.ok || !result.path) {
      return reply.status(500).send({ error: result.error ?? "Diagnostics collection failed." });
    }
    return { ok: true, path: result.path };
  });

  /** Get token cost breakdown. */
  server.get("/cost", {
    schema: {
      tags: ["Data"],
      response: { 200: CostResponse },
    },
  }, async () => {
    const ct = server.sessionManager.getCostTracker();
    if (!ct) return { breakdown: null, formatted: "" };

    return {
      breakdown: ct.getBreakdown(),
      formatted: ct.formatTokens(),
    };
  });
};
