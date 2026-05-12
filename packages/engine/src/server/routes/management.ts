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
import { randomBytes } from "node:crypto";
import {
  loadConnectionStore, saveConnectionStore, buildEffectiveConnections,
  addConnection, removeConnection, setTierAssignment, updateConnectionModels,
  maskKey,
} from "../../config/connections.js";
import type { ConnectionStore, TierAssignment, ProviderType, AIConnection } from "../../config/connections.js";
import { createProviderFromConnection } from "../../providers/index.js";
import { loadModelRegistry, getModelsForProvider, modelFamilyFor } from "../../config/model-registry.js";
import {
  CodexRpcClient, startChatGptLogin, awaitLoginCompletion, cancelLogin, getAccount,
  listModels,
} from "../../providers/openai-chatgpt/index.js";
import {
  archiveCampaign, deleteCampaign, listArchivedCampaigns,
  unarchiveCampaign, getCampaignDeleteInfo,
} from "../../config/campaign-archive.js";
import { loadDiscordSettings, saveDiscordSettings } from "../../config/discord.js";
import { loadMachineSettings, saveMachineSettings } from "../../config/machine-settings.js";
import { createArchiveFileIO } from "../fileio.js";
import {
  IdParams, NameParams,
  AddConnectionRequest, ConnectionsListResponse, HealthCheckResponse,
  UpdateModelsRequest, OkResponse, TiersResponse, SetTiersRequest,
  ModelsResponse, ArchiveResponse, ArchivedListResponse, RestoreRequest,
  DiscordSettings, MachineSettingsResponse, KeysListResponse, DeleteInfoResponse, ErrorResponse,
  ChatGptLoginStartResponse, ChatGptLoginStatusResponse,
  UsageResponse,
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

  /** Add a connection. `openai-chatgpt` excluded — uses OAuth login flow instead. */
  const VALID_PROVIDERS = new Set<string>(["anthropic", "openai-apikey", "openrouter", "custom"]);

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

    // Auto-discover known models for this provider's model family
    const knownModels = getModelsForProvider(modelFamilyFor(provider), server.configDir);
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

  // -----------------------------------------------------------------------
  // openai-chatgpt OAuth login flow
  // -----------------------------------------------------------------------
  //
  // The Codex app-server hosts the OAuth loopback callback itself (on
  // localhost:1455). We spawn a per-login codex subprocess just long
  // enough to drive the flow, then dispose it once the login completes
  // or fails. On success, a new AIConnection of type "openai-chatgpt" is
  // persisted and returned to the client via the status poll.

  interface PendingLogin {
    client: CodexRpcClient;
    status: "pending" | "success" | "error" | "cancelled";
    error?: string;
    email?: string;
    planType?: string;
    connectionId?: string;
    createdAt: number;
  }
  const pendingLogins = new Map<string, PendingLogin>();

  /** Reap logins older than 10 minutes to avoid unbounded growth. */
  function reapStaleLogins(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, login] of pendingLogins) {
      if (login.createdAt < cutoff && login.status !== "pending") {
        void login.client.stop().catch(() => { /* ignore */ });
        pendingLogins.delete(id);
      }
    }
  }

  server.post("/connections/openai-chatgpt/login", {
    schema: {
      tags: ["Management"],
      response: { 200: ChatGptLoginStartResponse, 500: ErrorResponse },
    },
  }, async (_request, reply) => {
    reapStaleLogins();

    const client = new CodexRpcClient({ sessionId: `oauth-${randomBytes(4).toString("hex")}` });
    try {
      await client.start();
      await client.call("initialize", {
        clientInfo: { name: "machine_violet", title: "Machine Violet", version: "1.0.1" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});

      const startResult = await startChatGptLogin(client);

      const entry: PendingLogin = {
        client,
        status: "pending",
        createdAt: Date.now(),
      };
      pendingLogins.set(startResult.loginId, entry);

      // Wire completion handler — fires once Codex finishes the OAuth flow
      // (success or failure). On success, also save the connection record.
      void awaitLoginCompletion(client, startResult.loginId)
        .then(async (completed) => {
          if (entry.status !== "pending") return; // cancelled
          if (!completed.success) {
            entry.status = "error";
            entry.error = completed.error ?? "login failed";
            await client.stop().catch(() => { /* ignore */ });
            return;
          }
          // Pull the resolved account details and persist the connection.
          try {
            const acct = await getAccount(client);
            entry.email = acct.account?.email;
            entry.planType = acct.account?.planType;

            // Discover models so the new connection has gpt-5.5 etc. populated
            // up front (avoids an empty tier-picker on first open).
            let discovered: { id: string; displayName: string; available: boolean }[] = [];
            try {
              discovered = (await listModels(client)).map((m) => ({
                id: m.id, displayName: m.displayName, available: m.available,
              }));
            } catch { /* best effort */ }

            const connId = randomBytes(8).toString("hex");
            const newConn: AIConnection = {
              id: connId,
              provider: "openai-chatgpt",
              label: acct.account?.email
                ? `ChatGPT (${acct.account.email})`
                : "ChatGPT",
              apiKey: "", // Codex owns tokens; no key to store
              chatgptAccount: acct.account
                ? {
                    id: acct.account.email ?? connId, // best fallback when codex omits a numeric id
                    email: acct.account.email,
                    planType: acct.account.planType,
                  }
                : undefined,
              models: discovered,
              source: "oauth",
              addedAt: new Date().toISOString(),
            };
            const stored = loadConnectionStore(server.configDir);
            stored.connections.push(newConn);
            saveConnectionStore(server.configDir, stored);
            entry.connectionId = connId;
            entry.status = "success";
          } catch (err) {
            entry.status = "error";
            entry.error = err instanceof Error ? err.message : String(err);
          } finally {
            // Either way, the login-only codex is no longer needed; the
            // user's game-session work will spawn a fresh one.
            await client.stop().catch(() => { /* ignore */ });
          }
        })
        .catch((err) => {
          entry.status = "error";
          entry.error = err instanceof Error ? err.message : String(err);
          void client.stop().catch(() => { /* ignore */ });
        });

      return { loginId: startResult.loginId, authUrl: startResult.authUrl };
    } catch (err) {
      await client.stop().catch(() => { /* ignore */ });
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.get("/connections/openai-chatgpt/login/:loginId", {
    schema: {
      tags: ["Management"],
      params: NameParams,
      response: { 200: ChatGptLoginStatusResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const { name: loginId } = request.params as { name: string };
    const entry = pendingLogins.get(loginId);
    if (!entry) {
      return reply.status(404).send({ error: `Unknown loginId: ${loginId}` });
    }
    return {
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
      ...(entry.email ? { email: entry.email } : {}),
      ...(entry.planType ? { planType: entry.planType } : {}),
    };
  });

  server.post("/connections/openai-chatgpt/login/:loginId/cancel", {
    schema: {
      tags: ["Management"],
      params: NameParams,
      response: { 200: OkResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const { name: loginId } = request.params as { name: string };
    const entry = pendingLogins.get(loginId);
    if (!entry) {
      return reply.status(404).send({ error: `Unknown loginId: ${loginId}` });
    }
    if (entry.status === "pending") {
      entry.status = "cancelled";
      await cancelLogin(entry.client, loginId).catch(() => { /* ignore */ });
      await entry.client.stop().catch(() => { /* ignore */ });
    }
    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // Usage status
  // -----------------------------------------------------------------------

  server.get("/connections/:id/usage", {
    schema: {
      tags: ["Management"],
      params: IdParams,
      response: { 200: UsageResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = getConnections();
    const conn = store.connections.find((c) => c.id === id);
    if (!conn) {
      return reply.status(404).send({ error: "Connection not found." });
    }

    // Look up the live provider instance from the session manager.
    // Only providers attached to an active session can report usage; idle
    // connections have no subprocess and no recent rate-limit snapshot.
    const provider = server.sessionManager.getProviderForConnectionId(id);
    if (!provider || !provider.getUsageStatus) {
      return { id, available: false };
    }
    const status = provider.getUsageStatus();
    if (!status) {
      return { id, available: false };
    }
    return { id, available: true, status };
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
    if (server.sessionManager.isBusy) {
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
    if (server.sessionManager.isBusy) {
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
  // Machine Settings (feature flags)
  // -----------------------------------------------------------------------

  /** Get machine-scoped settings (dev mode, etc.). */
  server.get("/settings", {
    schema: {
      tags: ["Management"],
      response: { 200: MachineSettingsResponse },
    },
  }, async () => {
    return loadMachineSettings(server.configDir);
  });

  /** Update machine-scoped settings. */
  server.put("/settings", {
    schema: {
      tags: ["Management"],
      body: MachineSettingsResponse,
      response: { 200: MachineSettingsResponse },
    },
  }, async (request) => {
    const { devModeEnabled } = request.body as { devModeEnabled: boolean };
    const settings = { devModeEnabled };
    saveMachineSettings(server.configDir, settings);
    return settings;
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
