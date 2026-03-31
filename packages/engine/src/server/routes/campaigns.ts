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
import {
  IdParams, ListCampaignsResponse, StartCampaignResponse, SessionStatusResponse, ErrorResponse,
} from "@machine-violet/shared";
import { listCampaigns } from "../../config/main-menu.js";

export const campaignRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  /** List available campaigns. */
  server.get("/", {
    schema: {
      tags: ["Campaigns"],
      response: { 200: ListCampaignsResponse },
    },
  }, async () => {
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
  server.post("/", {
    schema: {
      tags: ["Campaigns"],
      response: {
        201: StartCampaignResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (_request, reply) => {
    const sm = server.sessionManager;
    if (sm.isActive) {
      return reply.status(409).send({ error: "A session is already active." });
    }

    try {
      await sm.startSetup();
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to start setup: ${err instanceof Error ? err.message : err}`,
      });
    }

    return reply.status(201).send({
      sessionId: "__setup__",
      wsUrl: "/session/ws",
    });
  });

  /** Check whether a session is currently active (for poll-and-wait on exit). */
  server.get("/session-status", {
    schema: {
      tags: ["Campaigns"],
      response: { 200: SessionStatusResponse },
    },
  }, async () => {
    return { status: server.sessionManager.sessionStatus };
  });

  /** Start or resume an existing campaign. */
  server.post("/:id/start", {
    schema: {
      tags: ["Campaigns"],
      params: IdParams,
      response: {
        200: StartCampaignResponse,
        400: ErrorResponse,
        409: ErrorResponse,
      },
    },
  }, async (request, reply) => {
    const sm = server.sessionManager;
    if (sm.isActive) {
      return reply.status(409).send({ error: "A session is already active." });
    }

    const campaignId = (request.params as { id: string }).id;
    try {
      await sm.startSession(campaignId);
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Failed to start session.",
      });
    }

    return {
      sessionId: campaignId,
      wsUrl: `/session/ws`,
    };
  });
};
