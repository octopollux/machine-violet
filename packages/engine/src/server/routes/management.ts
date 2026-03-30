/**
 * Management routes — pre-session operations for app configuration.
 *
 * These don't require an active game session. They manage AI provider
 * connections, campaign archive/delete, and Discord settings.
 *
 * Prefix: /manage
 */
import { join } from "node:path";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  loadConnectionStore, saveConnectionStore, buildEffectiveConnections,
  addConnection, removeConnection, setTierAssignment, updateConnectionModels,
  maskKey,
} from "../../config/connections.js";
import type { ConnectionStore, TierAssignment, ProviderType } from "../../config/connections.js";
import { createProviderFromConnection } from "../../providers/index.js";
import { loadModelRegistry, getModelsForProvider } from "../../config/model-registry.js";
import {
  archiveCampaign, deleteCampaign, listArchivedCampaigns,
  unarchiveCampaign, getCampaignDeleteInfo,
} from "../../config/campaign-archive.js";
import { loadDiscordSettings, saveDiscordSettings } from "../../config/discord.js";
import { createArchiveFileIO } from "../fileio.js";
import {
  IdParams, NameParams,
  AddConnectionRequest, ConnectionsListResponse, HealthCheckResponse,
  UpdateModelsRequest, OkResponse, TiersResponse, SetTiersRequest,
  ModelsResponse, ArchiveResponse, ArchivedListResponse, RestoreRequest,
  DiscordSettings, KeysListResponse, DeleteInfoResponse, ErrorResponse,
} from "@machine-violet/shared";

export const managementRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // -----------------------------------------------------------------------
  // Connections
  // -----------------------------------------------------------------------

  function getConnections(): ConnectionStore {
    const stored = loadConnectionStore(server.configDir);
    return buildEffectiveConnections(stored, server.configDir);
  }

  function persistAndReturn(store: ConnectionStore): ConnectionStore {
    saveConnectionStore(server.configDir, store);
    return buildEffectiveConnections(loadConnectionStore(server.configDir), server.configDir);
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
  server.get("/connections", {
    schema: {
      tags: ["Management"],
      response: { 200: ConnectionsListResponse },
    },
  }, async () => {
    const store = getConnections();
    return {
      connections: store.connections.map(serializeConnection),
      tierAssignments: store.tierAssignments,
    };
  });

  /** Add a connection. */
  const VALID_PROVIDERS = new Set<string>(["anthropic", "openai", "openai-oauth", "openrouter", "custom"]);

  server.post("/connections", {
    schema: {
      tags: ["Management"],
      body: AddConnectionRequest,
      response: {
        201: ConnectionsListResponse,
        400: ErrorResponse,
      },
    },
  }, async (request, reply) => {
    const { provider, apiKey, label, baseUrl } = request.body as {
      provider: string; apiKey: string; label?: string; baseUrl?: string;
    };
    if (!provider || !apiKey) {
      return reply.status(400).send({ error: "Missing provider or apiKey." });
    }
    if (!VALID_PROVIDERS.has(provider)) {
      return reply.status(400).send({ error: `Unknown provider: ${provider}. Valid: ${[...VALID_PROVIDERS].join(", ")}` });
    }

    let store = getConnections();
    store = addConnection(store, provider as ProviderType, apiKey, label ?? "", baseUrl);

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
  server.delete("/connections/:id", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: ConnectionsListResponse, 400: ErrorResponse },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
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
  server.post("/connections/:id/check", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: HealthCheckResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const store = getConnections();
    const conn = store.connections.find((c) => c.id === (request.params as { id: string }).id);
    if (!conn) {
      return reply.status(404).send({ error: "Connection not found." });
    }

    try {
      const provider = createProviderFromConnection(conn);
      const result = await provider.healthCheck();
      return { id: conn.id, ...result };
    } catch (err) {
      return { id: conn.id, status: "error" as const, message: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Update discovered models on a connection. */
  server.put("/connections/:id/models", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      body: UpdateModelsRequest,
      response: { 200: OkResponse },
    },
  }, async (request) => {
    let store = getConnections();
    store = updateConnectionModels(store, (request.params as { id: string }).id, (request.body as { models: { id: string; displayName: string; available: boolean }[] })?.models ?? []);
    persistAndReturn(store);
    return { ok: true };
  });

  /** Get tier assignments. */
  server.get("/tiers", {
    schema: {
      tags: ["Management"],
      response: { 200: TiersResponse },
    },
  }, async () => {
    const store = getConnections();
    return { tierAssignments: store.tierAssignments };
  });

  /** Set tier assignments. */
  server.put("/tiers", {
    schema: {
      tags: ["Management"],
      body: SetTiersRequest,
      response: { 200: TiersResponse },
    },
  }, async (request) => {
    let store = getConnections();
    const body = (request.body as { large?: TierAssignment; medium?: TierAssignment; small?: TierAssignment }) ?? {};
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
  server.get("/models", {
    schema: {
      tags: ["Management"],
      response: { 200: ModelsResponse },
    },
  }, async () => {
    const registry = loadModelRegistry(server.configDir);
    return { models: registry.models };
  });

  // -----------------------------------------------------------------------
  // Legacy key endpoints (backward compat for existing client)
  // -----------------------------------------------------------------------

  server.get("/keys", {
    schema: {
      tags: ["Management"],
      response: { 200: KeysListResponse },
    },
  }, async () => {
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

  server.post("/keys/:id/check", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: HealthCheckResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const store = getConnections();
    const conn = store.connections.find((c) => c.id === (request.params as { id: string }).id);
    if (!conn) {
      return reply.status(404).send({ error: "Connection not found." });
    }
    try {
      const provider = createProviderFromConnection(conn);
      const result = await provider.healthCheck();
      return { id: conn.id, ...result };
    } catch (err) {
      return { id: conn.id, status: "error" as const, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // -----------------------------------------------------------------------
  // Campaign Archive / Delete
  // -----------------------------------------------------------------------

  const campaignsDir = () => server.sessionManager.getCampaignsDir();

  /** Get info for delete confirmation dialog. */
  server.get("/campaigns/:id/delete-info", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: DeleteInfoResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const campaignPath = join(campaignsDir(), (request.params as { id: string }).id);
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
  server.post("/campaigns/:id/archive", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: ArchiveResponse, 409: ErrorResponse, 500: ErrorResponse },
    },
  }, async (request, reply) => {
    if (server.sessionManager.isActive) {
      return reply.status(409).send({ error: "Cannot archive while a session is active." });
    }

    const campaignPath = join(campaignsDir(), (request.params as { id: string }).id);
    const io = createArchiveFileIO();
    const result = await archiveCampaign(campaignPath, campaignsDir(), io);

    if (!result.ok) {
      return reply.status(500).send({ error: result.error ?? "Archive failed." });
    }
    return { ok: true, zipPath: result.zipPath };
  });

  /** Permanently delete a campaign. */
  server.delete("/campaigns/:id", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: OkResponse, 409: ErrorResponse, 500: ErrorResponse },
    },
  }, async (request, reply) => {
    if (server.sessionManager.isActive) {
      return reply.status(409).send({ error: "Cannot delete while a session is active." });
    }

    const campaignPath = join(campaignsDir(), (request.params as { id: string }).id);
    const io = createArchiveFileIO();
    const result = await deleteCampaign(campaignPath, io);

    if (!result.ok) {
      return reply.status(500).send({ error: result.error ?? "Delete failed." });
    }
    return { ok: true };
  });

  /** List archived campaigns. */
  server.get("/campaigns/archived", {
    schema: {
      tags: ["Management"],
      response: { 200: ArchivedListResponse },
    },
  }, async () => {
    const io = createArchiveFileIO();
    const archives = await listArchivedCampaigns(campaignsDir(), io);
    return { archives };
  });

  /** Restore an archived campaign. Body includes zipPath from the list response. */
  server.post("/campaigns/archived/:name/restore", {
    schema: {
      tags: ["Management"],
      params: NameParams,
      body: RestoreRequest,
      response: { 200: OkResponse, 500: ErrorResponse },
    },
  }, async (request, reply) => {
    // Prefer explicit zipPath from body; fall back to reconstructing from name
    const zipPath = (request.body as { zipPath?: string })?.zipPath
      ?? join(campaignsDir(), "archivedcampaigns", `${(request.params as { name: string }).name}.zip`);
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
  server.get("/discord", {
    schema: {
      tags: ["Management"],
      response: { 200: DiscordSettings },
    },
  }, async () => {
    return loadDiscordSettings(server.configDir);
  });

  /** Update Discord Rich Presence setting. */
  server.put("/discord", {
    schema: {
      tags: ["Management"],
      body: DiscordSettings,
      response: { 200: DiscordSettings },
    },
  }, async (request) => {
    const { enabled } = (request.body as { enabled: boolean }) ?? {};
    const settings = { enabled: enabled === true };
    saveDiscordSettings(server.configDir, settings);
    return settings;
  });
};
