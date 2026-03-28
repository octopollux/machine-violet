/**
 * Campaign management routes.
 *
 * GET  /campaigns           — list available campaigns
 * POST /campaigns           — create new campaign (start setup pseudo-campaign)
 * POST /campaigns/:id/start — start/resume an existing campaign
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { ListCampaignsResponse, StartCampaignResponse } from "@machine-violet/shared";

export const campaignRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  /** List available campaigns. */
  server.get("/", async (_request, _reply) => {
    // TODO: Phase 2a — scan campaignsDir for valid campaign directories
    const response: ListCampaignsResponse = {
      campaigns: [],
    };
    return response;
  });

  /** Create a new campaign (enter setup pseudo-campaign). */
  server.post("/", async (_request, reply) => {
    const sm = server.sessionManager;
    if (sm.isActive) {
      return reply.status(409).send({ error: "A session is already active." });
    }

    // TODO: Phase 2c — create SetupSession that wraps SetupConversation
    // For now, return a stub
    const sessionId = crypto.randomUUID();
    const response: StartCampaignResponse = {
      sessionId,
      wsUrl: `/session/ws`,
    };
    return reply.status(201).send(response);
  });

  /** Start or resume an existing campaign. */
  server.post<{ Params: { id: string } }>("/:id/start", async (request, reply) => {
    const sm = server.sessionManager;
    if (sm.isActive) {
      return reply.status(409).send({ error: "A session is already active." });
    }

    const campaignId = request.params.id;
    try {
      await sm.startSession(campaignId);
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Failed to start session.",
      });
    }

    const response: StartCampaignResponse = {
      sessionId: campaignId,
      wsUrl: `/session/ws`,
    };
    return response;
  });
};
