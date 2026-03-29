/**
 * Campaign management routes.
 *
 * GET  /campaigns           — list available campaigns
 * POST /campaigns           — create new campaign (start setup pseudo-campaign)
 * POST /campaigns/:id/start — start/resume an existing campaign
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { StartCampaignResponse } from "@machine-violet/shared";
import { listCampaigns } from "../../config/main-menu.js";

export const campaignRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  /** List available campaigns. */
  server.get("/", async () => {
    const campaignsDir = server.sessionManager.getCampaignsDir();

    const entries = await listCampaigns(
      campaignsDir,
      (p) => readdir(p),
      async (p) => { try { await stat(p); return true; } catch { return false; } },
      (p) => readFile(p, "utf-8"),
    );

    return {
      campaigns: entries.map((e) => ({
        id: basename(e.path),
        name: e.name,
        path: e.path,
      })),
    };
  });

  /** Create a new campaign (enter setup pseudo-campaign). */
  server.post("/", async (_request, reply) => {
    const sm = server.sessionManager;
    if (sm.isActive) {
      return reply.status(409).send({ error: "A session is already active." });
    }

    // TODO: setup pseudo-campaign
    return reply.status(501).send({ error: "Campaign creation not yet implemented. Use the monolith to create campaigns." });
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
