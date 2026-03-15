import { describe, it, expect, beforeEach } from "vitest";
import {
  buildEffectiveStore,
  addKey,
  removeKey,
  setActiveKey,
  setTokenBudget,
  getActiveKeyValue,
  getActiveKeyEntry,
  maskKey,
} from "./api-keys.js";
import type { ApiKeyStore } from "./api-keys.js";

const FAKE_KEY = "sk-ant-api03-test1234567890abcdefghijklmnopqrstuvwxyz";
const FAKE_KEY_2 = "sk-ant-api03-another9876543210zyxwvutsrqponmlkjihgf";

function emptyStore(): ApiKeyStore {
  return { keys: [], activeKeyId: null };
}

function storeWith(keyOverrides?: Partial<ApiKeyStore>): ApiKeyStore {
  return {
    keys: [{
      id: "manual1",
      label: "Test key",
      key: FAKE_KEY,
      source: "manual",
      addedAt: "2026-01-01T00:00:00Z",
    }],
    activeKeyId: "manual1",
    ...keyOverrides,
  };
}

describe("maskKey", () => {
  it("masks a normal-length key", () => {
    const masked = maskKey(FAKE_KEY);
    expect(masked).toMatch(/^sk-ant-api\.{3}[a-z]{4}$/);
    expect(masked.length).toBeLessThan(FAKE_KEY.length);
  });

  it("handles short keys", () => {
    expect(maskKey("short")).toBe("sk-***");
  });
});

describe("buildEffectiveStore", () => {
  let origEnv: string | undefined;
  beforeEach(() => {
    origEnv = process.env.ANTHROPIC_API_KEY;
  });

  it("includes env key when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-envkey1234567890abcdefghijkl";
    const result = buildEffectiveStore(emptyStore());
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].id).toBe("env");
    expect(result.keys[0].source).toBe("env");
    expect(result.activeKeyId).toBe("env");
    process.env.ANTHROPIC_API_KEY = origEnv;
  });

  it("merges env key with manual keys", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-envkey1234567890abcdefghijkl";
    const store = storeWith();
    const result = buildEffectiveStore(store);
    expect(result.keys).toHaveLength(2);
    expect(result.keys[0].source).toBe("env");
    expect(result.keys[1].source).toBe("manual");
    process.env.ANTHROPIC_API_KEY = origEnv;
  });

  it("works without env key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const store = storeWith();
    const result = buildEffectiveStore(store);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].source).toBe("manual");
    process.env.ANTHROPIC_API_KEY = origEnv;
  });

  it("defaults activeKeyId to first key if stored one is gone", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const store = storeWith({ activeKeyId: "nonexistent" });
    const result = buildEffectiveStore(store);
    expect(result.activeKeyId).toBe("manual1");
    process.env.ANTHROPIC_API_KEY = origEnv;
  });
});

describe("addKey", () => {
  it("adds a key and generates an id", () => {
    const store = emptyStore();
    const updated = addKey(store, FAKE_KEY, "My key");
    expect(updated.keys).toHaveLength(1);
    expect(updated.keys[0].label).toBe("My key");
    expect(updated.keys[0].key).toBe(FAKE_KEY);
    expect(updated.keys[0].source).toBe("manual");
    expect(updated.keys[0].id).toBeTruthy();
  });

  it("sets activeKeyId if none was set", () => {
    const store = emptyStore();
    const updated = addKey(store, FAKE_KEY, "My key");
    expect(updated.activeKeyId).toBe(updated.keys[0].id);
  });

  it("preserves existing activeKeyId", () => {
    const store = storeWith();
    const updated = addKey(store, FAKE_KEY_2, "Second key");
    expect(updated.activeKeyId).toBe("manual1");
  });

  it("generates masked label when label is empty", () => {
    const updated = addKey(emptyStore(), FAKE_KEY, "");
    expect(updated.keys[0].label).toContain("...");
  });
});

describe("removeKey", () => {
  it("removes a key by id", () => {
    const store = storeWith();
    const updated = removeKey(store, "manual1");
    expect(updated.keys).toHaveLength(0);
    expect(updated.activeKeyId).toBeNull();
  });

  it("refuses to remove env key", () => {
    const store: ApiKeyStore = {
      keys: [{ id: "env", label: "Env", key: "sk-xxx", source: "env", addedAt: "" }],
      activeKeyId: "env",
    };
    const updated = removeKey(store, "env");
    expect(updated.keys).toHaveLength(1);
  });

  it("updates activeKeyId when active key is removed", () => {
    let store = storeWith();
    store = addKey(store, FAKE_KEY_2, "Second");
    // Active is manual1, remove it
    const updated = removeKey(store, "manual1");
    expect(updated.activeKeyId).toBe(updated.keys[0].id);
  });
});

describe("setActiveKey", () => {
  it("sets the active key", () => {
    let store = storeWith();
    store = addKey(store, FAKE_KEY_2, "Second");
    const secondId = store.keys[1].id;
    const updated = setActiveKey(store, secondId);
    expect(updated.activeKeyId).toBe(secondId);
  });

  it("ignores nonexistent key id", () => {
    const store = storeWith();
    const updated = setActiveKey(store, "bogus");
    expect(updated.activeKeyId).toBe("manual1");
  });
});

describe("setTokenBudget", () => {
  it("sets a budget on a key", () => {
    const store = storeWith();
    const updated = setTokenBudget(store, "manual1", 1_000_000);
    expect(updated.keys[0].tokenBudget).toBe(1_000_000);
  });

  it("clears a budget", () => {
    let store = storeWith();
    store = setTokenBudget(store, "manual1", 500_000);
    const updated = setTokenBudget(store, "manual1", undefined);
    expect(updated.keys[0].tokenBudget).toBeUndefined();
  });
});

describe("getActiveKeyValue", () => {
  it("returns the active key's value", () => {
    expect(getActiveKeyValue(storeWith())).toBe(FAKE_KEY);
  });

  it("returns null when no active key", () => {
    expect(getActiveKeyValue(emptyStore())).toBeNull();
  });
});

describe("getActiveKeyEntry", () => {
  it("returns the full entry", () => {
    const entry = getActiveKeyEntry(storeWith());
    expect(entry?.label).toBe("Test key");
  });

  it("returns null when no active key", () => {
    expect(getActiveKeyEntry(emptyStore())).toBeNull();
  });
});
