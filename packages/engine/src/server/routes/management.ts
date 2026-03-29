/**
 * Management routes — pre-session operations for app configuration.
 *
 * These don't require an active game session. They manage API keys,
 * campaign archive/delete, and Discord settings.
 *
 * Prefix: /manage
 *
 * API Keys:
 *   GET    /keys              — list all keys (masked)
 *   POST   /keys              — add a manual key
 *   DELETE /keys/:id          — remove a manual key
 *   POST   /keys/:id/activate — set as active key
 *   POST   /keys/:id/check    — health-check a key
 *
 * Campaign Ops:
 *   POST   /campaigns/:id/archive   — archive a campaign to zip
 *   DELETE /campaigns/:id            — permanently delete a campaign
 *   GET    /campaigns/archived       — list archived campaigns
 *   POST   /campaigns/archived/:name/restore — unarchive a campaign
 *   GET    /campaigns/:id/delete-info — get info for delete confirmation
 *
 * Discord:
 *   GET    /discord            — get Discord Rich Presence setting
 *   PUT    /discord            — update Discord Rich Presence setting
 */
import { join } from "node:path";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  loadKeyStore, saveKeyStore, buildEffectiveStore,
  addKey, removeKey, setActiveKey, maskKey,
} from "../../config/api-keys.js";
import { checkKeyHealth, formatHealthStatus, formatRateLimits } from "../../config/api-key-health.js";
import {
  archiveCampaign, deleteCampaign, listArchivedCampaigns,
  unarchiveCampaign, getCampaignDeleteInfo,
} from "../../config/campaign-archive.js";
import { loadDiscordSettings, saveDiscordSettings } from "../../config/discord.js";
import { createBaseFileIO } from "../fileio.js";

export const managementRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  // -----------------------------------------------------------------------
  // API Keys
  // -----------------------------------------------------------------------

  /** Helper: load effective store (env + manual keys). */
  function getStore() {
    const stored = loadKeyStore(server.configDir);
    return buildEffectiveStore(stored);
  }

  /** Helper: persist store and return effective store. */
  function persistAndReturn(store: ReturnType<typeof buildEffectiveStore>) {
    saveKeyStore(server.configDir, store);
    return buildEffectiveStore(loadKeyStore(server.configDir));
  }

  /** List all keys (masked). */
  server.get("/keys", async () => {
    const store = getStore();
    return {
      keys: store.keys.map((k) => ({
        id: k.id,
        label: k.label,
        masked: maskKey(k.key),
        source: k.source,
        addedAt: k.addedAt,
        tokenBudget: k.tokenBudget,
        isActive: k.id === store.activeKeyId,
      })),
      activeKeyId: store.activeKeyId,
    };
  });

  /** Add a manual key. */
  server.post<{ Body: { key: string; label?: string } }>("/keys", async (request, reply) => {
    const { key, label } = request.body ?? {};
    if (!key || typeof key !== "string") {
      return reply.status(400).send({ error: "Missing 'key' field." });
    }

    let store = getStore();
    store = addKey(store, key, label ?? "");
    const effective = persistAndReturn(store);

    return reply.status(201).send({
      keys: effective.keys.map((k) => ({
        id: k.id,
        label: k.label,
        masked: maskKey(k.key),
        source: k.source,
        isActive: k.id === effective.activeKeyId,
      })),
      activeKeyId: effective.activeKeyId,
    });
  });

  /** Remove a manual key. */
  server.delete<{ Params: { id: string } }>("/keys/:id", async (request, reply) => {
    const { id } = request.params;
    if (id === "env") {
      return reply.status(400).send({ error: "Cannot remove environment key." });
    }

    let store = getStore();
    store = removeKey(store, id);
    const effective = persistAndReturn(store);

    return {
      keys: effective.keys.map((k) => ({
        id: k.id,
        label: k.label,
        masked: maskKey(k.key),
        source: k.source,
        isActive: k.id === effective.activeKeyId,
      })),
      activeKeyId: effective.activeKeyId,
    };
  });

  /** Activate a key. */
  server.post<{ Params: { id: string } }>("/keys/:id/activate", async (request) => {
    let store = getStore();
    store = setActiveKey(store, request.params.id);
    persistAndReturn(store);
    return { ok: true, activeKeyId: store.activeKeyId };
  });

  /** Health-check a key. */
  server.post<{ Params: { id: string } }>("/keys/:id/check", async (request, reply) => {
    const store = getStore();
    const entry = store.keys.find((k) => k.id === request.params.id);
    if (!entry) {
      return reply.status(404).send({ error: "Key not found." });
    }

    const result = await checkKeyHealth(entry.key);
    return {
      id: entry.id,
      status: result.status,
      message: formatHealthStatus(result),
      rateLimits: result.rateLimits ? formatRateLimits(result.rateLimits) : null,
    };
  });

  // -----------------------------------------------------------------------
  // Campaign Archive / Delete
  // -----------------------------------------------------------------------

  const campaignsDir = () => server.sessionManager.getCampaignsDir();

  /** Get info for delete confirmation dialog. */
  server.get<{ Params: { id: string } }>("/campaigns/:id/delete-info", async (request, reply) => {
    const campaignPath = join(campaignsDir(), request.params.id);
    const io = createBaseFileIO();
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
    const io = createBaseFileIO();
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
    const io = createBaseFileIO();
    const result = await deleteCampaign(campaignPath, io);

    if (!result.ok) {
      return reply.status(500).send({ error: result.error ?? "Delete failed." });
    }
    return { ok: true };
  });

  /** List archived campaigns. */
  server.get("/campaigns/archived", async () => {
    const io = createBaseFileIO();
    const archives = await listArchivedCampaigns(campaignsDir(), io);
    return { archives };
  });

  /** Restore an archived campaign. */
  server.post<{ Params: { name: string } }>("/campaigns/archived/:name/restore", async (request, reply) => {
    const zipPath = join(campaignsDir(), "archivedcampaigns", `${request.params.name}.zip`);
    const io = createBaseFileIO();
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
