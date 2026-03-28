/**
 * Session routes — gameplay interaction endpoints.
 *
 * All routes require an active session (enforced via preHandler).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type {
  ContributeRequest,
  CommitResponse,
  CommandRequest,
  ModalResponse,
  SessionEndResponse,
  StateSnapshot,
} from "@machine-violet/shared";

export const sessionRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // Require active session for all routes in this plugin
  server.addHook("preHandler", async (request, reply) => {
    if (!server.sessionManager.isActive) {
      return reply.status(400).send({ error: "No active session." });
    }
  });

  /** Get full state snapshot (for reconnect / initial load). */
  server.get("/state", async () => {
    const snapshot: StateSnapshot = server.sessionManager.buildStateSnapshot();
    return snapshot;
  });

  /** Contribute to the current turn. */
  server.post<{ Body: ContributeRequest }>("/turn/contribute", async (request, reply) => {
    const tm = server.sessionManager.getTurnManager();
    if (!tm) {
      return reply.status(400).send({ error: "No turn manager." });
    }

    const turn = tm.getCurrentTurn();
    if (!turn || turn.status !== "open") {
      return reply.status(400).send({ error: "No open turn." });
    }

    const { text } = request.body;
    // TODO: resolve playerId from connection identity / query param
    const playerId = (request.query as Record<string, string>).player ?? turn.activePlayers[0] ?? "player";

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
  server.post("/turn/commit", async (_request, reply) => {
    const tm = server.sessionManager.getTurnManager();
    if (!tm) {
      return reply.status(400).send({ error: "No turn manager." });
    }

    try {
      await tm.commit();
      const turn = tm.getCurrentTurn();
      const response: CommitResponse = { turnId: turn?.id ?? "" };
      return response;
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Failed to commit turn.",
      });
    }
  });

  /** Execute a slash command. */
  server.post<{ Params: { name: string }; Body: CommandRequest }>(
    "/command/:name",
    async (request, _reply) => {
      const { name } = request.params;
      const { args } = request.body ?? {};

      // TODO: Phase 2a — dispatch to SlashCommand registry
      // The server handles OOC/Dev mode transitions internally.
      // Commands like /save, /rollback, /scene call engine methods.
      server.log.info({ command: name, args }, "Slash command received");

      return { ok: true, command: name };
    },
  );

  /** Respond to a modal (choice selection, dice acknowledgment, etc.). */
  server.post<{ Params: { id: string }; Body: ModalResponse }>(
    "/modal/:id/respond",
    async (request, _reply) => {
      const { id } = request.params;
      const { value } = request.body;

      // TODO: Phase 2a — resolve pending modal promises
      // For choice modals, the value is the selected index.
      // Feed the selection back into the agent loop.
      server.log.info({ modalId: id, value }, "Modal response received");

      return { ok: true };
    },
  );

  /** Patch settings directly (temporary — frontend knows the shape). */
  server.patch("/settings", async (request, _reply) => {
    // TODO: Phase 2a — apply settings patch to CampaignConfig
    server.log.info({ settings: request.body }, "Settings patch received");
    return { ok: true };
  });

  /** End the current session. */
  server.post("/end", async () => {
    await server.sessionManager.endSession();
    const response: SessionEndResponse = { summary: "Session ended." };
    return response;
  });
};
