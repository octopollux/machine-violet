/**
 * Multi-key API key store.
 *
 * Manual keys are persisted to `api-keys.json` in the app directory.
 * The environment key (from ANTHROPIC_API_KEY) is always included at
 * runtime via `buildEffectiveStore()` but never written to the store file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  source: "env" | "manual";
  addedAt: string;
  /** Optional token budget — warnings fire when session usage approaches this. */
  tokenBudget?: number;
}

export interface ApiKeyStore {
  keys: ApiKeyEntry[];
  activeKeyId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_FILENAME = "api-keys.json";
const ENV_KEY_ID = "env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return randomBytes(8).toString("hex");
}

/** Mask a key for safe display: `sk-ant-api0...Ab1Z` */
export function maskKey(key: string): string {
  if (key.length < 14) return "sk-***";
  return key.slice(0, 10) + "..." + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load the persisted key store (manual keys only). */
export function loadKeyStore(appDir: string): ApiKeyStore {
  try {
    const raw = readFileSync(join(appDir, STORE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as ApiKeyStore;
    // Filter to only manual keys — env key is added at runtime
    return {
      keys: (parsed.keys ?? []).filter((k) => k.source === "manual"),
      activeKeyId: parsed.activeKeyId ?? null,
    };
  } catch {
    return { keys: [], activeKeyId: null };
  }
}

/** Save the key store (writes only manual keys). */
export function saveKeyStore(appDir: string, store: ApiKeyStore): void {
  const toSave: ApiKeyStore = {
    keys: store.keys.filter((k) => k.source === "manual"),
    activeKeyId: store.activeKeyId,
  };
  writeFileSync(join(appDir, STORE_FILENAME), JSON.stringify(toSave, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

/**
 * Build the effective key list: env key (if present) + stored manual keys.
 * The env key always gets id "env" and appears first.
 */
export function buildEffectiveStore(stored: ApiKeyStore): ApiKeyStore {
  const envKey = process.env.ANTHROPIC_API_KEY;
  const manualKeys = stored.keys.filter((k) => k.source === "manual");

  const keys: ApiKeyEntry[] = [];
  if (envKey) {
    keys.push({
      id: ENV_KEY_ID,
      label: "Environment (.env)",
      key: envKey,
      source: "env",
      addedAt: "",
    });
  }
  keys.push(...manualKeys);

  // Resolve active key: keep stored preference if it still exists, else default to first
  let activeKeyId = stored.activeKeyId;
  if (!activeKeyId || !keys.find((k) => k.id === activeKeyId)) {
    activeKeyId = keys.length > 0 ? keys[0].id : null;
  }

  return { keys, activeKeyId };
}

/** Add a new manual key. Returns the updated store. */
export function addKey(store: ApiKeyStore, key: string, label: string): ApiKeyStore {
  const entry: ApiKeyEntry = {
    id: generateId(),
    label: label || maskKey(key),
    key,
    source: "manual",
    addedAt: new Date().toISOString(),
  };
  const newKeys = [...store.keys, entry];
  return {
    keys: newKeys,
    activeKeyId: store.activeKeyId ?? entry.id,
  };
}

/** Remove a key by id. Cannot remove the env key. Returns the updated store. */
export function removeKey(store: ApiKeyStore, keyId: string): ApiKeyStore {
  if (keyId === ENV_KEY_ID) return store; // env key can't be removed
  const newKeys = store.keys.filter((k) => k.id !== keyId);
  let activeKeyId = store.activeKeyId;
  if (activeKeyId === keyId) {
    activeKeyId = newKeys.length > 0 ? newKeys[0].id : null;
  }
  return { keys: newKeys, activeKeyId };
}

/** Set the active key. Returns the updated store. */
export function setActiveKey(store: ApiKeyStore, keyId: string): ApiKeyStore {
  if (!store.keys.find((k) => k.id === keyId)) return store;
  return { ...store, activeKeyId: keyId };
}

/** Set a token budget on a key. Returns the updated store. */
export function setTokenBudget(store: ApiKeyStore, keyId: string, budget: number | undefined): ApiKeyStore {
  return {
    ...store,
    keys: store.keys.map((k) => k.id === keyId ? { ...k, tokenBudget: budget } : k),
  };
}

/** Get the API key string for the active key, or null. */
export function getActiveKeyValue(store: ApiKeyStore): string | null {
  if (!store.activeKeyId) return null;
  const entry = store.keys.find((k) => k.id === store.activeKeyId);
  return entry?.key ?? null;
}

/** Get the full entry for the active key, or null. */
export function getActiveKeyEntry(store: ApiKeyStore): ApiKeyEntry | null {
  if (!store.activeKeyId) return null;
  return store.keys.find((k) => k.id === store.activeKeyId) ?? null;
}
