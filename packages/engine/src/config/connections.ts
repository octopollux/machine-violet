/**
 * AI provider connection management.
 *
 * A connection is a provider + credential + discovered models.
 * Replaces the single-provider api-keys.ts with multi-provider support.
 *
 * Connections are persisted to `connections.json` in the app config dir.
 * Environment keys (ANTHROPIC_API_KEY, OPENAI_API_KEY) auto-create
 * connections at runtime via buildEffectiveConnections().
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getModelsForProvider, getTierDefaults, modelFamilyFor } from "./model-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderType = "anthropic" | "openai-apikey" | "openai-chatgpt" | "openrouter" | "custom";

export interface DiscoveredModel {
  id: string;
  displayName: string;
  available: boolean;
}

/**
 * Identity metadata + persisted OAuth tokens for an OpenAI/ChatGPT-account
 * connection. We own the OAuth flow ourselves (codex's built-in flow
 * requires an allowlisted originator for its connectors scopes), so we
 * also own token storage. The access_token is pushed into codex at every
 * session start; the refresh_token is used to mint a new access_token
 * when the current one expires (codex sends us a refresh request when
 * it gets a 401).
 *
 * Tokens are persisted here in plaintext — same trust boundary as
 * `apiKey` for the API-key providers. The local machine is trusted.
 */
export interface ChatGptAccountInfo {
  /** ChatGPT account ID from the OAuth id_token claim. */
  id: string;
  /** Account email (best-effort, may be absent for some flows). */
  email?: string;
  /** Plan tier: plus, pro, business, enterprise, etc. */
  planType?: string;
  /** Current access token (JWT). Pushed to codex on session start. */
  accessToken?: string;
  /** Refresh token. Used to mint a new accessToken when the current expires. */
  refreshToken?: string;
  /** id_token from the last token response (kept for debugging / claim re-parse). */
  idToken?: string;
  /** Epoch ms when `accessToken` expires. Used to decide whether to refresh. */
  expiresAtMs?: number;
}

export interface AIConnection {
  id: string;
  provider: ProviderType;
  label: string;
  /**
   * API key. Always present for key-based providers; empty string (or
   * unused) for `openai-chatgpt` connections, where Codex manages tokens
   * internally. Kept as a required string for backward compatibility with
   * persisted connections.json files.
   */
  apiKey: string;
  baseUrl?: string;
  /** Populated for `openai-chatgpt` connections only. */
  chatgptAccount?: ChatGptAccountInfo;
  models: DiscoveredModel[];
  source: "env" | "manual" | "oauth";
  addedAt: string;
}

export interface ConnectionStore {
  connections: AIConnection[];
  /** Model → connection mapping for each tier. */
  tierAssignments: TierAssignments;
}

export interface TierAssignments {
  large: TierAssignment | null;
  medium: TierAssignment | null;
  small: TierAssignment | null;
}

export interface TierAssignment {
  connectionId: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_FILENAME = "connections.json";
const ENV_ANTHROPIC_ID = "env-anthropic";
const ENV_OPENAI_ID = "env-openai";

function generateId(): string {
  return randomBytes(8).toString("hex");
}

/** Mask a key for safe display. */
export function maskKey(key: string): string {
  if (key.length < 14) return "***";
  return key.slice(0, 10) + "..." + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadConnectionStore(appDir: string): ConnectionStore {
  try {
    const raw = readFileSync(join(appDir, STORE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as ConnectionStore;
    // Migrate legacy provider strings in-place. The disk format predates the
    // 2026-05 split where `openai` became `openai-apikey` and the unused
    // `openai-oauth` scaffolding was retired in favor of `openai-chatgpt`
    // (which routes through codex app-server, not the OpenAI SDK).
    const migrated = (parsed.connections ?? [])
      .filter((c) => c.source !== "env")
      .map((c) => {
        const raw = c.provider as unknown as string;
        if (raw === "openai") return { ...c, provider: "openai-apikey" as ProviderType };
        return c;
      })
      // Drop legacy openai-oauth records — never actually wired to a working
      // login path. Users on the new openai-chatgpt path re-create via OAuth.
      .filter((c) => (c.provider as unknown as string) !== "openai-oauth");
    return {
      connections: migrated,
      tierAssignments: parsed.tierAssignments ?? { large: null, medium: null, small: null },
    };
  } catch {
    return { connections: [], tierAssignments: { large: null, medium: null, small: null } };
  }
}

export function saveConnectionStore(appDir: string, store: ConnectionStore): void {
  const toSave: ConnectionStore = {
    connections: store.connections.filter((c) => c.source !== "env"),
    tierAssignments: store.tierAssignments,
  };
  writeFileSync(join(appDir, STORE_FILENAME), JSON.stringify(toSave, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Effective store (env + manual)
// ---------------------------------------------------------------------------

export function buildEffectiveConnections(stored: ConnectionStore, configDir?: string): ConnectionStore {
  const connections: AIConnection[] = [];

  // Environment: Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const knownModels = getModelsForProvider("anthropic", configDir);
    connections.push({
      id: ENV_ANTHROPIC_ID,
      provider: "anthropic",
      label: "Anthropic (env)",
      apiKey: anthropicKey,
      models: Object.entries(knownModels).map(([id, m]) => ({
        id, displayName: m.displayName, available: true,
      })),
      source: "env",
      addedAt: "",
    });
  }

  // Environment: OpenAI (key-based — distinct from openai-chatgpt subscription auth)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const knownModels = getModelsForProvider(modelFamilyFor("openai-apikey"), configDir);
    connections.push({
      id: ENV_OPENAI_ID,
      provider: "openai-apikey",
      label: "OpenAI (env)",
      apiKey: openaiKey,
      models: Object.entries(knownModels).map(([id, m]) => ({
        id, displayName: m.displayName, available: true,
      })),
      source: "env",
      addedAt: "",
    });
  }

  // Manual connections — refresh models from the registry on every load.
  //
  // For registry-backed providers (anthropic, openai-apikey) the model list
  // is purely derived from `known-models.json` — there's no user-editable
  // per-model state to preserve, so always rebuilding picks up new entries
  // (e.g. a newly-shipped flagship like gpt-5.5) without requiring the user
  // to delete and re-add their connection.
  //
  // For `custom` / unknown providers the registry has no entries and
  // `getModelsForProvider` returns an empty map; in that case fall back to
  // populating only when the stored list is empty, since the user (or some
  // future probe step) may have set models manually against a custom
  // OpenAI-compatible endpoint.
  //
  // `openai-chatgpt` is harmless either way: its models are overwritten by
  // a live `model/list` call against the codex subprocess at session
  // startup, so whatever lands here gets replaced before the model picker
  // ever consults it.
  for (const conn of stored.connections.filter((c) => c.source !== "env")) {
    if (!conn.models) conn.models = [];
    const knownModels = getModelsForProvider(modelFamilyFor(conn.provider), configDir);
    const knownIds = Object.keys(knownModels);
    if (knownIds.length > 0) {
      conn.models = knownIds.map((id) => ({
        id, displayName: knownModels[id].displayName, available: true,
      }));
    } else if (conn.models.length === 0) {
      // Custom/unknown provider with no stored models — leave empty; the
      // UI surfaces a "no models" state and the user can configure them.
    }
    connections.push(conn);
  }

  // Resolve tier assignments: keep stored if connection+model still exist
  const tierAssignments = { ...stored.tierAssignments };
  for (const tier of ["large", "medium", "small"] as const) {
    const assignment = tierAssignments[tier];
    if (assignment && connections.find((c) => c.id === assignment.connectionId)) {
      continue; // Valid assignment
    }

    // Auto-assign from first connection that has provider tier defaults
    tierAssignments[tier] = null;
    for (const conn of connections) {
      const defaults = getTierDefaults(conn.provider, configDir);
      if (defaults?.[tier]) {
        const modelId = defaults[tier];
        if (conn.models.find((m) => m.id === modelId)) {
          tierAssignments[tier] = { connectionId: conn.id, modelId };
          break;
        }
      }
    }
  }

  return { connections, tierAssignments };
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

export function addConnection(
  store: ConnectionStore,
  provider: ProviderType,
  apiKey: string,
  label: string,
  baseUrl?: string,
): ConnectionStore {
  const connection: AIConnection = {
    id: generateId(),
    provider,
    label: label || `${provider} key`,
    apiKey,
    baseUrl,
    models: [],
    source: "manual",
    addedAt: new Date().toISOString(),
  };
  return {
    ...store,
    connections: [...store.connections, connection],
  };
}

export function removeConnection(store: ConnectionStore, connectionId: string): ConnectionStore {
  if (connectionId === ENV_ANTHROPIC_ID || connectionId === ENV_OPENAI_ID) return store;
  const connections = store.connections.filter((c) => c.id !== connectionId);
  // Clear tier assignments that referenced this connection
  const tierAssignments = { ...store.tierAssignments };
  for (const tier of ["large", "medium", "small"] as const) {
    if (tierAssignments[tier]?.connectionId === connectionId) {
      tierAssignments[tier] = null;
    }
  }
  return { connections, tierAssignments };
}

export function setTierAssignment(
  store: ConnectionStore,
  tier: "large" | "medium" | "small",
  connectionId: string,
  modelId: string,
): ConnectionStore {
  return {
    ...store,
    tierAssignments: {
      ...store.tierAssignments,
      [tier]: { connectionId, modelId },
    },
  };
}

export function updateConnectionModels(
  store: ConnectionStore,
  connectionId: string,
  models: DiscoveredModel[],
): ConnectionStore {
  return {
    ...store,
    connections: store.connections.map((c) =>
      c.id === connectionId ? { ...c, models } : c,
    ),
  };
}

/**
 * Result of merging a freshly-OAuthed ChatGPT account into the store.
 * Mutates `store` in place; also returns metadata callers need (e.g. to
 * dispose live providers for replaced connections, or to look up the
 * resulting connectionId for the login-status poll).
 */
export interface UpsertChatGptResult {
  /** Connection ID after merge — either the preserved one or a freshly-minted one. */
  connectionId: string;
  /** Connection IDs that were removed during the merge. */
  removedIds: string[];
  /** True when an existing connection was refreshed in place. */
  replacedInPlace: boolean;
}

/**
 * Reconcile a freshly-OAuthed ChatGPT account against the store's
 * existing chatgpt connections. Three cases:
 *
 *   1. Exactly one prior chatgpt connection, regardless of whether
 *      `chatgptAccount.id` matches → refresh that record in place.
 *      Connection id is preserved, which is critical: in-memory provider
 *      instances created earlier in the session bind their token store
 *      to that id; minting a new id would orphan them. The `chatgptAccount`
 *      object is fully replaced (no field leakage from the prior account
 *      when the user switches accounts), but the connection id and any
 *      user-customized label carry over.
 *   2. Multiple prior chatgpt connections (legacy state from a pre-upsert
 *      build) → keep the one referenced by a tier assignment if possible,
 *      otherwise keep the first; drop the rest. Update the kept record's
 *      account fields as above.
 *   3. No prior chatgpt connection → mint a new one.
 *
 * Without this reconciliation, every "Sign in with ChatGPT" would
 * append a new record and tier assignments would still point at the
 * old (stale-tokened) one — defeating the purpose of re-signing in.
 *
 * Mutates `store` in place. The caller is responsible for persisting.
 */
export function upsertChatGptConnection(
  store: ConnectionStore,
  account: ChatGptAccountInfo,
  discoveredModels: DiscoveredModel[],
): UpsertChatGptResult {
  const priorChatGpt = store.connections.filter((c) => c.provider === "openai-chatgpt");

  let keepTarget: AIConnection | undefined;
  if (priorChatGpt.length === 1) {
    keepTarget = priorChatGpt[0];
  } else if (priorChatGpt.length > 1) {
    // Prefer a record referenced by any tier assignment — that's the one
    // session providers were almost certainly built against. Falls back
    // to the first record otherwise.
    const tierReferencedIds = new Set<string>();
    for (const tier of ["large", "medium", "small"] as const) {
      const a = store.tierAssignments[tier];
      if (a) tierReferencedIds.add(a.connectionId);
    }
    keepTarget = priorChatGpt.find((c) => tierReferencedIds.has(c.id)) ?? priorChatGpt[0];
  }

  let connectionId: string;
  let removedIds: string[];
  let replacedInPlace: boolean;

  if (keepTarget) {
    const oldEmail = keepTarget.chatgptAccount?.email;
    keepTarget.chatgptAccount = { ...account };
    if (discoveredModels.length > 0) keepTarget.models = discoveredModels;
    // Refresh the email-derived label only if it still matches the default
    // form (`ChatGPT (<old-email>)`) — preserves any custom label.
    if (account.email) {
      const oldLabel = oldEmail ? `ChatGPT (${oldEmail})` : "ChatGPT";
      if (keepTarget.label === oldLabel || keepTarget.label === "ChatGPT") {
        keepTarget.label = `ChatGPT (${account.email})`;
      }
    }
    connectionId = keepTarget.id;
    removedIds = priorChatGpt.filter((c) => c.id !== keepTarget.id).map((c) => c.id);
    replacedInPlace = true;
  } else {
    connectionId = generateId();
    const newConn: AIConnection = {
      id: connectionId,
      provider: "openai-chatgpt",
      label: account.email ? `ChatGPT (${account.email})` : "ChatGPT",
      apiKey: "",
      chatgptAccount: { ...account },
      models: discoveredModels,
      source: "oauth",
      addedAt: new Date().toISOString(),
    };
    removedIds = [];
    store.connections.push(newConn);
    replacedInPlace = false;
  }

  if (removedIds.length > 0) {
    store.connections = store.connections.filter((c) => !removedIds.includes(c.id));
  }

  // Tier assignments pointing at any removed legacy record are migrated
  // to the kept connection if the modelId is still available; otherwise
  // nulled out so buildEffectiveConnections re-resolves a default.
  const keptModels = store.connections.find((c) => c.id === connectionId)?.models ?? [];
  for (const tier of ["large", "medium", "small"] as const) {
    const assignment = store.tierAssignments[tier];
    if (!assignment) continue;
    if (!removedIds.includes(assignment.connectionId)) continue;
    const hasModel = keptModels.some((m) => m.id === assignment.modelId);
    store.tierAssignments[tier] = hasModel
      ? { connectionId, modelId: assignment.modelId }
      : null;
  }

  return { connectionId, removedIds, replacedInPlace };
}

/** Get the connection + model for a tier. Returns null if not assigned. */
export function getTierProvider(
  store: ConnectionStore,
  tier: "large" | "medium" | "small",
): { connection: AIConnection; modelId: string } | null {
  const assignment = store.tierAssignments[tier];
  if (!assignment) return null;
  const connection = store.connections.find((c) => c.id === assignment.connectionId);
  if (!connection) return null;
  return { connection, modelId: assignment.modelId };
}
