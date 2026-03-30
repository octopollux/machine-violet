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
import { getModelsForProvider, getTierDefaults } from "./model-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderType = "anthropic" | "openai" | "openai-oauth" | "openrouter" | "custom";

export interface DiscoveredModel {
  id: string;
  displayName: string;
  available: boolean;
}

export interface AIConnection {
  id: string;
  provider: ProviderType;
  label: string;
  apiKey: string;
  baseUrl?: string;
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
    return {
      connections: (parsed.connections ?? []).filter((c) => c.source !== "env"),
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

  // Environment: OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const knownModels = getModelsForProvider("openai", configDir);
    connections.push({
      id: ENV_OPENAI_ID,
      provider: "openai",
      label: "OpenAI (env)",
      apiKey: openaiKey,
      models: Object.entries(knownModels).map(([id, m]) => ({
        id, displayName: m.displayName, available: true,
      })),
      source: "env",
      addedAt: "",
    });
  }

  // Manual connections — auto-populate models if empty or missing
  for (const conn of stored.connections.filter((c) => c.source !== "env")) {
    if (!conn.models) conn.models = [];
    if (conn.models.length === 0) {
      const knownModels = getModelsForProvider(conn.provider, configDir);
      conn.models = Object.entries(knownModels).map(([id, m]) => ({
        id, displayName: m.displayName, available: true,
      }));
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

/** Find a connection by ID. */
export function getConnection(store: ConnectionStore, connectionId: string): AIConnection | undefined {
  return store.connections.find((c) => c.id === connectionId);
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
