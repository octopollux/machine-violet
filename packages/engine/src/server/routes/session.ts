/**
 * Session routes — gameplay interaction endpoints.
 *
 * All routes require an active session (enforced via preHandler).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  ContributeRequest, ContributeResponse, ContributeQuery,
  CommitResponse, CommandRequest, CommandParams, CommandResponse,
  ChoiceResponseRequest, OkResponse, CyclePlayerResponse,
  SessionEndResponse, ErrorResponse, StateSnapshot,
} from "@machine-violet/shared";
import { handleCommand } from "../command-handler.js";

export const sessionRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // Require active session for all routes in this plugin
  server.addHook("preHandler", async (request, reply) => {
    if (!server.sessionManager.isActive) {
      return reply.status(400).send({ error: "No active session." });
    }
  });

  /** Get full state snapshot (for reconnect / initial load). */
  server.get("/state", {
    schema: {
      tags: ["Session"],
      response: { 200: StateSnapshot },
    },
  }, async () => {
    return server.sessionManager.buildStateSnapshot();
  });

  /** Contribute to the current turn. */
  server.post("/turn/contribute", {
    schema: {
      tags: ["Session"],
      body: ContributeRequest,
      querystring: ContributeQuery,
      response: {
        200: ContributeResponse,
        400: ErrorResponse,
      },
    },
  }, async (request, reply) => {
    console.log(`[contribute] text="${(request.body as ContributeRequest)?.text?.slice(0, 50)}"`);
    const tm = server.sessionManager.getTurnManager();
    if (!tm) {
      return reply.status(400).send({ error: "No turn manager." });
    }

    // Wait briefly for a turn to be open (previous turn may still be processing)
    let turn = tm.getCurrentTurn();
    if (turn && turn.status === "processing") {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        turn = tm.getCurrentTurn();
        if (!turn || turn.status === "open") break;
      }
    }
    if (!turn || turn.status !== "open") {
      server.log.warn({ turnStatus: turn?.status ?? "null", turnId: turn?.id ?? "none" }, "Contribution rejected: no open turn");
      return reply.status(400).send({ error: `No open turn. (status: ${turn?.status ?? "null"})` });
    }

    const { text } = request.body as { text: string };
    // Resolve player: use query param if it matches an active player, otherwise default to first active
    const queryPlayer = (request.query as Record<string, string>).player;
    const playerId = (queryPlayer && turn.activePlayers.includes(queryPlayer))
      ? queryPlayer
      : turn.activePlayers[0] ?? "player";

    try {
      const contribution = tm.contribute(playerId, text);
      return { turnId: turn.id, contributionId: contribution.id };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Failed to contribute.",
      });
    }
  });

  /** Explicitly commit the current turn. */
  server.post("/turn/commit", {
    schema: {
      tags: ["Session"],
      response: {
        200: CommitResponse,
        400: ErrorResponse,
      },
    },
  }, async (_request, reply) => {
    const tm = server.sessionManager.getTurnManager();
    if (!tm) {
      return reply.status(400).send({ error: "No turn manager." });
    }

    try {
      await tm.commit();
      const turn = tm.getCurrentTurn();
      return { turnId: turn?.id ?? "" };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Failed to commit turn.",
      });
    }
  });

  /** Execute a slash command. */
  server.post("/command/:name", {
    schema: {
      tags: ["Session"],
      params: CommandParams,
      body: CommandRequest,
      response: {
        200: CommandResponse,
        400: ErrorResponse,
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { args } = (request.body as { args?: string }) ?? {};

    const sm = server.sessionManager;
    const engine = sm.getEngine();
    const gameState = sm.getGameState();
    if (!engine || !gameState) {
      return reply.status(400).send({ error: "No active engine." });
    }

    const result = await handleCommand(
      name, args ?? "", engine, gameState,
      (event) => sm.broadcast(event),
    );

    // Broadcast system message to all clients
    if (result.message) {
      sm.broadcast({
        type: "narrative:chunk",
        data: { text: `[${result.message}]`, kind: "system" },
      });
    }

    if (result.endSession) {
      await sm.endSession();
    }

    return { ok: !result.error, message: result.message };
  });

  /** Respond to a choice presented by the DM or setup agent. */
  server.post("/choice/respond", {
    schema: {
      tags: ["Session"],
      body: ChoiceResponseRequest,
      response: { 200: OkResponse },
    },
  }, async (request, _reply) => {
    const { value } = (request.body as { value: string }) ?? {};

    // During setup, resolve choice selections through the session manager
    // (which handles turn lifecycle + game transition)
    const sm = server.sessionManager;
    const setup = sm.getSetupSession();
    if (setup) {
      await sm.resolveSetupChoice(String(value));
      return { ok: true };
    }

    server.log.info({ value }, "Choice response received");
    return { ok: true };
  });

  /** Cycle to the next player (Tab key). */
  server.post("/player/cycle", {
    schema: {
      tags: ["Session"],
      response: {
        200: CyclePlayerResponse,
        400: ErrorResponse,
      },
    },
  }, async (_request, reply) => {
    const gs = server.sessionManager.getGameState();
    if (!gs) return reply.status(400).send({ error: "No game state." });

    const playerCount = gs.config.players.length;
    if (playerCount <= 1) return { activePlayerIndex: 0 };

    gs.activePlayerIndex = (gs.activePlayerIndex + 1) % playerCount;
    const player = gs.config.players[gs.activePlayerIndex];

    // Broadcast updated state
    server.sessionManager.broadcast({
      type: "state:snapshot",
      data: server.sessionManager.buildStateSnapshot(),
    });

    return { activePlayerIndex: gs.activePlayerIndex, character: player.character };
  });

  /** End the current session. */
  server.post("/end", {
    schema: {
      tags: ["Session"],
      response: { 200: SessionEndResponse },
    },
  }, async () => {
    await server.sessionManager.endSession();
    return { summary: "Session ended." };
  });
};

