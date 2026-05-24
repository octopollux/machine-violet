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
  CodexRpcClient, startChatGptThirdPartyOAuth, pushChatGptAuthTokens, getAccount,
  listModels, getCodexClientInfo,
} from "../../providers/openai-chatgpt/index.js";
import type { OAuthFlow } from "../../providers/openai-chatgpt/index.js";
import {
  archiveCampaign, deleteCampaign, listArchivedCampaigns,
  unarchiveCampaign, getCampaignDeleteInfo,
} from "../../config/campaign-archive.js";
import { loadDiscordSettings, saveDiscordSettings } from "../../config/discord.js";
import { loadMachineSettings, saveMachineSettings } from "../../config/machine-settings.js";
import { createArchiveFileIO } from "../fileio.js";
import {
  IdParams, NameParams, LoginIdParams,
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
  // We drive the OAuth flow ourselves (PKCE + loopback on localhost:1455
  // + minimal `openid profile email offline_access` scopes), then push
  // the resulting access_token into codex via `account/login/start
  // type:"chatgptAuthTokens"`. Codex's built-in chatgpt flow hardcodes
  // `api.connectors.*` scopes that gate behind an allowlisted originator —
  // this side-steps that. Same pattern as Cline, OpenClaw, and others.
  //
  // On success a new AIConnection of type "openai-chatgpt" is persisted,
  // including the refresh_token (we own refresh, codex calls back to us
  // via `account/chatgptAuthTokens/refresh` when its access_token 401s).

  interface PendingLogin {
    flow: OAuthFlow;
    status: "pending" | "success" | "error" | "cancelled";
    error?: string;
    email?: string;
    planType?: string;
    connectionId?: string;
    createdAt: number;
  }
  const pendingLogins = new Map<string, PendingLogin>();

  /**
   * Reap stale login entries to avoid unbounded growth and resource leaks.
   *
   * Terminal entries (success/error/cancelled) are deleted after 10 minutes
   * — they're just status-poll caches at that point. Pending entries that
   * have aged past 30 minutes are forcibly cancelled and deleted: each
   * pending entry holds an OAuthFlow whose loopback HTTP server stays
   * bound to port 1455 until `flow.cancel()` fires, so an abandoned login
   * blocks any subsequent login attempt. 30 minutes is well past the
   * outer-edge of a real user finishing the browser OAuth round-trip.
   */
  function reapStaleLogins(): void {
    const now = Date.now();
    const terminalCutoff = now - 10 * 60_000;
    const pendingCutoff = now - 30 * 60_000;
    for (const [id, login] of pendingLogins) {
      if (login.status === "pending") {
        if (login.createdAt < pendingCutoff) {
          try { login.flow.cancel(); } catch { /* ignore */ }
          pendingLogins.delete(id);
        }
      } else if (login.createdAt < terminalCutoff) {
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

    const clientInfo = getCodexClientInfo();
    server.log.info({ originator: clientInfo.name }, "openai-chatgpt login start");

    let flow: OAuthFlow;
    try {
      flow = startChatGptThirdPartyOAuth({ originator: clientInfo.name });
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const entry: PendingLogin = {
      flow,
      status: "pending",
      createdAt: Date.now(),
    };
    pendingLogins.set(flow.loginId, entry);

    void flow.result.then(async (tokens) => {
      if (entry.status !== "pending") return; // cancelled before tokens arrived
      if (!tokens.chatgptAccountId) {
        entry.status = "error";
        entry.error = "OAuth response missing chatgpt_account_id claim";
        return;
      }
      // Push the tokens into a short-lived codex subprocess so codex can
      // discover available models for us. We dispose it immediately
      // after; the user's game session spawns a fresh one that will read
      // the persisted tokens from the connection record.
      //
      // Cancellation races: this block takes several seconds (codex spawn,
      // initialize, account read, model list, disk write). The user can
      // hit the cancel endpoint at any of those await boundaries.
      // `flow.cancel()` only rejects an already-settled promise, so it
      // does nothing here — we have to actively check `entry.status` at
      // each await boundary and bail before persisting the connection.
      // The `finally` block always stops the codex subprocess so the
      // partial work doesn't leak the loopback port either way.
      const codex = new CodexRpcClient({ sessionId: `oauth-${randomBytes(4).toString("hex")}` });
      try {
        await codex.start();
        if (entry.status !== "pending") return;
        await codex.call("initialize", {
          clientInfo,
          capabilities: { experimentalApi: true },
        });
        if (entry.status !== "pending") return;
        codex.notify("initialized", {});
        await pushChatGptAuthTokens(codex, tokens);
        if (entry.status !== "pending") return;

        // Confirm account is logged in + pull display metadata.
        const acct = await getAccount(codex);
        if (entry.status !== "pending") return;
        entry.email = acct.account?.email ?? tokens.email;
        entry.planType = acct.account?.planType ?? tokens.chatgptPlanType ?? undefined;

        // Discover available models up front so the tier-picker isn't empty
        // on first open.
        let discovered: { id: string; displayName: string; available: boolean }[] = [];
        try {
          discovered = (await listModels(codex)).map((m) => ({
            id: m.id, displayName: m.displayName, available: m.available,
          }));
        } catch { /* best effort */ }
        if (entry.status !== "pending") return;

        const connId = randomBytes(8).toString("hex");
        const newConn: AIConnection = {
          id: connId,
          provider: "openai-chatgpt",
          label: entry.email ? `ChatGPT (${entry.email})` : "ChatGPT",
          apiKey: "",
          chatgptAccount: {
            id: tokens.chatgptAccountId,
            email: entry.email,
            planType: entry.planType,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            expiresAtMs: tokens.expiresAtMs,
          },
          models: discovered,
          source: "oauth",
          addedAt: new Date().toISOString(),
        };
        // Final guard: cancellation between the model-list await and the
        // disk write would otherwise still persist the connection.
        if (entry.status !== "pending") return;
        const stored = loadConnectionStore(server.configDir);
        stored.connections.push(newConn);
        saveConnectionStore(server.configDir, stored);
        entry.connectionId = connId;
        entry.status = "success";
      } catch (err) {
        entry.status = "error";
        entry.error = err instanceof Error ? err.message : String(err);
      } finally {
        await codex.stop().catch(() => { /* ignore */ });
      }
    }).catch((err: unknown) => {
      if (entry.status === "cancelled") return;
      entry.status = "error";
      entry.error = err instanceof Error ? err.message : String(err);
    });

    return { loginId: flow.loginId, authUrl: flow.authUrl };
  });

  server.get("/connections/openai-chatgpt/login/:loginId", {
    schema: {
      tags: ["Management"],
      params: LoginIdParams,
      response: { 200: ChatGptLoginStatusResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const { loginId } = request.params as { loginId: string };
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
      params: LoginIdParams,
      response: { 200: OkResponse, 404: ErrorResponse },
    },
  }, async (request, reply) => {
    const { loginId } = request.params as { loginId: string };
    const entry = pendingLogins.get(loginId);
    if (!entry) {
      return reply.status(404).send({ error: `Unknown loginId: ${loginId}` });
    }
    if (entry.status === "pending") {
      entry.status = "cancelled";
      entry.flow.cancel();
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
    const { enabled } = request.body as { enabled: boolean };
    const settings = { enabled };
    saveDiscordSettings(server.configDir, settings);
    return settings;
  });
};
