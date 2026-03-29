/**
 * Management routes — pre-session operations for app configuration.
 *
 * These don't require an active game session. They manage AI provider
 * connections, campaign archive/delete, and Discord settings.
 *
 * Prefix: /manage
 *
 * Connections:
 *   GET    /connections                   — list all connections (masked keys)
 *   POST   /connections                   — add a connection
 *   DELETE /connections/:id               — remove a connection
 *   POST   /connections/:id/check         — health-check a connection
 *   PUT    /connections/:id/models        — update discovered models
 *   GET    /tiers                         — get tier assignments
 *   PUT    /tiers                         — set tier assignments
 *   GET    /models                        — list all known models
 *
 * Legacy (backward compat):
 *   GET    /keys                          — list connections as keys
 *   POST   /keys/:id/check               — health-check via connection
 *
 * Campaign Ops:
 *   POST   /campaigns/:id/archive        — archive a campaign to zip
 *   DELETE /campaigns/:id                 — permanently delete a campaign
 *   GET    /campaigns/archived            — list archived campaigns
 *   POST   /campaigns/archived/:name/restore — unarchive a campaign
 *   GET    /campaigns/:id/delete-info     — get info for delete confirmation
 *
 * Discord:
 *   GET    /discord                       — get Discord Rich Presence setting
 *   PUT    /discord                       — update Discord Rich Presence setting
 */
import { join } from "node:path";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  loadConnectionStore, saveConnectionStore, buildEffectiveConnections,
  addConnection, removeConnection, setTierAssignment, updateConnectionModels,
  maskKey,
} from "../../config/connections.js";
import type { ConnectionStore, TierAssignment } from "../../config/connections.js";
import { createProviderFromConnection } from "../../providers/index.js";
import { loadModelRegistry, getModelsForProvider } from "../../config/model-registry.js";
import {
  archiveCampaign, deleteCampaign, listArchivedCampaigns,
  unarchiveCampaign, getCampaignDeleteInfo,
} from "../../config/campaign-archive.js";
import { loadDiscordSettings, saveDiscordSettings } from "../../config/discord.js";
import { createArchiveFileIO } from "../fileio.js";

export const managementRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // -----------------------------------------------------------------------
  // Connections
  // -----------------------------------------------------------------------

  function getConnections(): ConnectionStore {
    const stored = loadConnectionStore(server.configDir);
    return buildEffectiveConnections(stored);
  }

  function persistAndReturn(store: ConnectionStore): ConnectionStore {
    saveConnectionStore(server.configDir, store);
    return buildEffectiveConnections(loadConnectionStore(server.configDir));
  }

  function serializeConnection(c: { id: string; provider: string; label: string; apiKey: string; baseUrl?: string; models: unknown[]; source: string; addedAt: string }) {
    return {
      id: c.id,
      provider: c.provider,
      label: c.label,
      masked: maskKey(c.apiKey),
      baseUrl: c.baseUrl,
      models: c.models,
      source: c.source,
      addedAt: c.addedAt,
    };
  }

  /** List all connections (masked keys). */
  server.get("/connections", async () => {
    const store = getConnections();
    return {
      connections: store.connections.map(serializeConnection),
      tierAssignments: store.tierAssignments,
    };
  });

  /** Add a connection. */
  server.post<{ Body: { provider: string; apiKey: string; label?: string; baseUrl?: string } }>("/connections", async (request, reply) => {
    const { provider, apiKey, label, baseUrl } = request.body ?? {};
    if (!provider || !apiKey) {
      return reply.status(400).send({ error: "Missing provider or apiKey." });
    }

    let store = getConnections();
    store = addConnection(store, provider as "anthropic" | "openai" | "openrouter" | "custom", apiKey, label ?? "", baseUrl);

    // Auto-discover known models for this provider
    const knownModels = getModelsForProvider(provider, server.configDir);
    const newConn = store.connections[store.connections.length - 1];
    store = updateConnectionModels(store, newConn.id, Object.entries(knownModels).map(([id, m]) => ({
      id, displayName: m.displayName, available: true,
    })));

    const effective = persistAndReturn(store);
    return reply.status(201).send({
      connections: effective.connections.map(serializeConnection),
      tierAssignments: effective.tierAssignments,
    });
  });

  /** Remove a connection. */
  server.delete<{ Params: { id: string } }>("/connections/:id", async (request, reply) => {
    const { id } = request.params;
    if (id.startsWith("env-")) {
      return reply.status(400).send({ error: "Cannot remove environment connection." });
    }

    let store = getConnections();
    store = removeConnection(store, id);
    const effective = persistAndReturn(store);

    return {
      connections: effective.connections.map(serializeConnection),
      tierAssignments: effective.tierAssignments,
    };
  });

  /** Health-check a connection. */
  server.post<{ Params: { id: string } }>("/connections/:id/check", async (request, reply) => {
    const store = getConnections();
    const conn = store.connections.find((c) => c.id === request.params.id);
    if (!conn) {
      return reply.status(404).send({ error: "Connection not found." });
    }

    try {
      const provider = createProviderFromConnection(conn);
      const result = await provider.healthCheck();
      return { id: conn.id, ...result };
    } catch (err) {
      return { id: conn.id, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Update discovered models on a connection. */
  server.put<{ Params: { id: string }; Body: { models: { id: string; displayName: string; available: boolean }[] } }>("/connections/:id/models", async (request) => {
    let store = getConnections();
    store = updateConnectionModels(store, request.params.id, request.body?.models ?? []);
    persistAndReturn(store);
    return { ok: true };
  });

  /** Get tier assignments. */
  server.get("/tiers", async () => {
    const store = getConnections();
    return { tierAssignments: store.tierAssignments };
  });

  /** Set tier assignments. */
  server.put<{ Body: { large?: TierAssignment; medium?: TierAssignment; small?: TierAssignment } }>("/tiers", async (request) => {
    let store = getConnections();
    const body = request.body ?? {};
    for (const tier of ["large", "medium", "small"] as const) {
      const assignment = body[tier];
      if (assignment) {
        store = setTierAssignment(store, tier, assignment.connectionId, assignment.modelId);
      }
    }
    persistAndReturn(store);
    return { tierAssignments: store.tierAssignments };
  });

  /** List all known models from the registry. */
  server.get("/models", async () => {
    const registry = loadModelRegistry(server.configDir);
    return { models: registry.models };
  });

  // -----------------------------------------------------------------------
  // Legacy key endpoints (backward compat for existing client)
  // -----------------------------------------------------------------------

  server.get("/keys", async () => {
    const store = getConnections();
    return {
      keys: store.connections.map((c) => ({
        id: c.id,
        label: c.label,
        masked: maskKey(c.apiKey),
        source: c.source,
        addedAt: c.addedAt,
        isActive: false,
      })),
      activeKeyId: store.connections[0]?.id ?? null,
    };
  });

  server.post<{ Params: { id: string } }>("/keys/:id/check", async (request, reply) => {
    const store = getConnections();
    const conn = store.connections.find((c) => c.id === request.params.id);
    if (!conn) {
      return reply.status(404).send({ error: "Connection not found." });
    }
    try {
      const provider = createProviderFromConnection(conn);
      const result = await provider.healthCheck();
      return { id: conn.id, ...result };
    } catch (err) {
      return { id: conn.id, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  });

  // -----------------------------------------------------------------------
  // Campaign Archive / Delete
  // -----------------------------------------------------------------------

  const campaignsDir = () => server.sessionManager.getCampaignsDir();

  /** Get info for delete confirmation dialog. */
  server.get<{ Params: { id: string } }>("/campaigns/:id/delete-info", async (request, reply) => {
    const campaignPath = join(campaignsDir(), request.params.id);
    const io = createArchiveFileIO();
    try {
      const info = await getCampaignDeleteInfo(campaignPath, io);
      return info;
    } catch (err) {
      return reply.status(404).send({
        error: `Campaign not found: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  /** Archive a campaign to zip. */
  server.post<{ Params: { id: string } }>("/campaigns/:id/archive", async (request, reply) => {
    if (server.sessionManager.isActive) {
      return reply.status(409).send({ error: "Cannot archive while a session is active." });
    }

    const campaignPath = join(campaignsDir(), request.params.id);
    const io = createArchiveFileIO();
    const result = await archiveCampaign(campaignPath, campaignsDir(), io);

    if (!result.ok) {
      return reply.status(500).send({ error: result.error ?? "Archive failed." });
    }
    return { ok: true, zipPath: result.zipPath };
  });

  /** Permanently delete a campaign. */
  server.delete<{ Params: { id: string } }>("/campaigns/:id", async (request, reply) => {
    if (server.sessionManager.isActive) {
      return reply.status(409).send({ error: "Cannot delete while a session is active." });
    }

    const campaignPath = join(campaignsDir(), request.params.id);
    const io = createArchiveFileIO();
    const result = await deleteCampaign(campaignPath, io);

    if (!result.ok) {
      return reply.status(500).send({ error: result.error ?? "Delete failed." });
    }
    return { ok: true };
  });

  /** List archived campaigns. */
  server.get("/campaigns/archived", async () => {
    const io = createArchiveFileIO();
    const archives = await listArchivedCampaigns(campaignsDir(), io);
    return { archives };
  });

  /** Restore an archived campaign. Body includes zipPath from the list response. */
  server.post<{ Body: { zipPath?: string }; Params: { name: string } }>("/campaigns/archived/:name/restore", async (request, reply) => {
    // Prefer explicit zipPath from body; fall back to reconstructing from name
    const zipPath = request.body?.zipPath
      ?? join(campaignsDir(), "archivedcampaigns", `${request.params.name}.zip`);
    const io = createArchiveFileIO();
    const result = await unarchiveCampaign(zipPath, campaignsDir(), io);

    if (!result.ok) {
      return reply.status(500).send({ error: result.error ?? "Restore failed." });
    }
    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // Discord Settings
  // -----------------------------------------------------------------------

  /** Get Discord Rich Presence setting. */
  server.get("/discord", async () => {
    return loadDiscordSettings(server.configDir);
  });

  /** Update Discord Rich Presence setting. */
  server.put<{ Body: { enabled: boolean } }>("/discord", async (request) => {
    const { enabled } = request.body ?? {};
    const settings = { enabled: enabled === true };
    saveDiscordSettings(server.configDir, settings);
    return settings;
  });
};
