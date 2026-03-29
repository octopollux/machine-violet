/**
 * API key types and pure utility functions for the client.
 * No I/O — the server handles persistence.
 */

export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  source: "env" | "manual";
  addedAt: string;
  tokenBudget?: number;
}

export interface ApiKeyStore {
  keys: ApiKeyEntry[];
  activeKeyId: string | null;
}

/** Mask a key for safe display: `sk-ant-api0...Ab1Z` */
export function maskKey(key: string): string {
  if (key.length < 14) return "sk-***";
  return key.slice(0, 10) + "..." + key.slice(-4);
}

/** Add a new manual key to a local store copy. */
export function addKey(store: ApiKeyStore, key: string, label: string): ApiKeyStore {
  const entry: ApiKeyEntry = {
    id: crypto.randomUUID().slice(0, 16),
    label: label || maskKey(key),
    key,
    source: "manual",
    addedAt: new Date().toISOString(),
  };
  return {
    keys: [...store.keys, entry],
    activeKeyId: store.activeKeyId ?? entry.id,
  };
}

/** Remove a key by id. Cannot remove the env key. */
export function removeKey(store: ApiKeyStore, keyId: string): ApiKeyStore {
  if (keyId === "env") return store;
  const newKeys = store.keys.filter((k) => k.id !== keyId);
  let activeKeyId = store.activeKeyId;
  if (activeKeyId === keyId) {
    activeKeyId = newKeys.length > 0 ? newKeys[0].id : null;
  }
  return { keys: newKeys, activeKeyId };
}

/** Set the active key. */
export function setActiveKey(store: ApiKeyStore, keyId: string): ApiKeyStore {
  if (!store.keys.find((k) => k.id === keyId)) return store;
  return { ...store, activeKeyId: keyId };
}
