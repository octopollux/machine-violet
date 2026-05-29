import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConnectionStore, saveConnectionStore, buildEffectiveConnections,
  upsertChatGptConnection,
} from "./connections.js";
import type { AIConnection, ConnectionStore, ChatGptAccountInfo } from "./connections.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mv-conn-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadConnectionStore migration", () => {
  it("rewrites legacy provider 'openai' to 'openai-apikey'", () => {
    const legacy = {
      connections: [
        { id: "abc", provider: "openai", label: "OpenAI", apiKey: "sk-test", models: [], source: "manual", addedAt: "" },
      ],
      tierAssignments: { large: null, medium: null, small: null },
    };
    writeFileSync(join(tempDir, "connections.json"), JSON.stringify(legacy));
    const loaded = loadConnectionStore(tempDir);
    expect(loaded.connections).toHaveLength(1);
    expect(loaded.connections[0].provider).toBe("openai-apikey");
  });

  it("drops legacy 'openai-oauth' connections entirely", () => {
    const legacy = {
      connections: [
        { id: "abc", provider: "openai-oauth", label: "old oauth", apiKey: "stale", models: [], source: "manual", addedAt: "" },
        { id: "def", provider: "anthropic", label: "Anth", apiKey: "sk-ant", models: [], source: "manual", addedAt: "" },
      ],
      tierAssignments: { large: null, medium: null, small: null },
    };
    writeFileSync(join(tempDir, "connections.json"), JSON.stringify(legacy));
    const loaded = loadConnectionStore(tempDir);
    expect(loaded.connections).toHaveLength(1);
    expect(loaded.connections[0].provider).toBe("anthropic");
  });

  it("filters out env-source connections (env keys are reapplied at runtime)", () => {
    const data = {
      connections: [
        { id: "env-1", provider: "anthropic", label: "env", apiKey: "x", models: [], source: "env", addedAt: "" },
        { id: "manual-1", provider: "anthropic", label: "manual", apiKey: "y", models: [], source: "manual", addedAt: "" },
      ],
      tierAssignments: { large: null, medium: null, small: null },
    };
    writeFileSync(join(tempDir, "connections.json"), JSON.stringify(data));
    const loaded = loadConnectionStore(tempDir);
    expect(loaded.connections.map((c) => c.id)).toEqual(["manual-1"]);
  });

  it("returns an empty store when the file is missing or malformed", () => {
    expect(loadConnectionStore(tempDir).connections).toEqual([]);
    writeFileSync(join(tempDir, "connections.json"), "not json");
    expect(loadConnectionStore(tempDir).connections).toEqual([]);
  });
});

describe("saveConnectionStore", () => {
  it("persists manual connections only and re-readable round-trips them", () => {
    const conn: AIConnection = {
      id: "x", provider: "openai-chatgpt", label: "ChatGPT",
      apiKey: "", chatgptAccount: { id: "u@example.com", email: "u@example.com", planType: "plus" },
      models: [{ id: "gpt-5.5", displayName: "GPT-5.5", available: true }],
      source: "oauth", addedAt: "2026-05-12T00:00:00.000Z",
    };
    saveConnectionStore(tempDir, {
      connections: [conn],
      tierAssignments: { large: null, medium: null, small: null },
    });
    const loaded = loadConnectionStore(tempDir);
    expect(loaded.connections).toHaveLength(1);
    expect(loaded.connections[0]).toMatchObject(conn);
  });
});

describe("buildEffectiveConnections", () => {
  let savedAnthropic: string | undefined;
  let savedOpenai: string | undefined;

  beforeEach(() => {
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenai;
  });

  it("auto-creates an env connection for OPENAI_API_KEY with provider 'openai-apikey'", () => {
    process.env.OPENAI_API_KEY = "sk-test-env";
    const effective = buildEffectiveConnections({
      connections: [],
      tierAssignments: { large: null, medium: null, small: null },
    });
    const env = effective.connections.find((c) => c.source === "env" && c.provider === "openai-apikey");
    expect(env).toBeDefined();
    expect(env?.apiKey).toBe("sk-test-env");
  });

  it("refreshes a manual openai-apikey connection's models against the current registry", () => {
    // Simulate a connection saved before gpt-5.5 was added: its stored
    // `models` array is missing the new flagship. The loader should
    // rebuild from the registry so the picker surfaces all current
    // models — otherwise users have to delete and re-add their key
    // every time we ship a new model.
    const effective = buildEffectiveConnections({
      connections: [{
        id: "stale-openai", provider: "openai-apikey", label: "OpenAI",
        apiKey: "sk-test", models: [
          { id: "gpt-5.4", displayName: "GPT-5.4", available: true },
        ],
        source: "manual", addedAt: "2026-01-01",
      }],
      tierAssignments: { large: null, medium: null, small: null },
    });
    const conn = effective.connections.find((c) => c.id === "stale-openai");
    expect(conn).toBeDefined();
    const ids = conn!.models.map((m) => m.id);
    expect(ids).toContain("gpt-5.5");
    // Sanity check: other shipped models are also present.
    expect(ids).toContain("gpt-4o-mini");
  });

  it("leaves a manual custom-provider connection's models alone (no registry entries to refresh against)", () => {
    // Custom OpenAI-compatible endpoints (Ollama, vLLM, llama.cpp, …)
    // have no registry entries, so we must preserve whatever the user
    // configured rather than blanking the list.
    const effective = buildEffectiveConnections({
      connections: [{
        id: "custom-1", provider: "custom", label: "Local llama.cpp",
        apiKey: "", baseUrl: "http://localhost:8080",
        models: [{ id: "llama-3-70b", displayName: "Llama 3 70B", available: true }],
        source: "manual", addedAt: "2026-01-01",
      }],
      tierAssignments: { large: null, medium: null, small: null },
    });
    const conn = effective.connections.find((c) => c.id === "custom-1");
    expect(conn?.models).toEqual([{ id: "llama-3-70b", displayName: "Llama 3 70B", available: true }]);
  });
});

describe("upsertChatGptConnection", () => {
  function freshAccount(overrides: Partial<ChatGptAccountInfo> = {}): ChatGptAccountInfo {
    return {
      id: "acct-new",
      email: "new@example.com",
      planType: "plus",
      accessToken: "at-new",
      refreshToken: "rt-new",
      idToken: "id-new",
      expiresAtMs: 9_000_000,
      ...overrides,
    };
  }

  it("mints a new connection when no prior chatgpt connection exists", () => {
    const store: ConnectionStore = {
      connections: [],
      tierAssignments: { large: null, medium: null, small: null },
    };
    const result = upsertChatGptConnection(store, freshAccount(), [
      { id: "gpt-5.5", displayName: "GPT-5.5", available: true },
    ]);
    expect(result.replacedInPlace).toBe(false);
    expect(result.removedIds).toEqual([]);
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0].id).toBe(result.connectionId);
    expect(store.connections[0].provider).toBe("openai-chatgpt");
    expect(store.connections[0].label).toBe("ChatGPT (new@example.com)");
    expect(store.connections[0].chatgptAccount?.accessToken).toBe("at-new");
  });

  it("refreshes tokens in place when the same account signs in again, preserving connectionId", () => {
    const store: ConnectionStore = {
      connections: [{
        id: "existing-conn",
        provider: "openai-chatgpt",
        label: "My Custom Label",
        apiKey: "",
        chatgptAccount: {
          id: "acct-A",
          email: "a@example.com",
          accessToken: "at-old",
          refreshToken: "rt-old",
          expiresAtMs: 1000,
        },
        models: [{ id: "gpt-5.5", displayName: "GPT-5.5", available: true }],
        source: "oauth",
        addedAt: "2026-01-01",
      }],
      tierAssignments: {
        large: { connectionId: "existing-conn", modelId: "gpt-5.5" },
        medium: null,
        small: null,
      },
    };
    const result = upsertChatGptConnection(store, freshAccount({ id: "acct-A", email: "a@example.com" }), []);
    expect(result.replacedInPlace).toBe(true);
    expect(result.connectionId).toBe("existing-conn");
    expect(result.removedIds).toEqual([]);
    expect(store.connections).toHaveLength(1);
    // Custom label preserved
    expect(store.connections[0].label).toBe("My Custom Label");
    // Tokens refreshed
    expect(store.connections[0].chatgptAccount?.accessToken).toBe("at-new");
    expect(store.connections[0].chatgptAccount?.refreshToken).toBe("rt-new");
    // Tier assignment unchanged (same connectionId)
    expect(store.tierAssignments.large).toEqual({ connectionId: "existing-conn", modelId: "gpt-5.5" });
  });

  it("refreshes the default-form label when the email changes for the same account", () => {
    const store: ConnectionStore = {
      connections: [{
        id: "existing-conn",
        provider: "openai-chatgpt",
        label: "ChatGPT (old@example.com)",
        apiKey: "",
        chatgptAccount: {
          id: "acct-A",
          email: "old@example.com",
          accessToken: "at",
          refreshToken: "rt",
          expiresAtMs: 1,
        },
        models: [],
        source: "oauth",
        addedAt: "",
      }],
      tierAssignments: { large: null, medium: null, small: null },
    };
    upsertChatGptConnection(store, freshAccount({ id: "acct-A", email: "renamed@example.com" }), []);
    expect(store.connections[0].label).toBe("ChatGPT (renamed@example.com)");
  });

  it("preserves the connectionId across an account switch so live providers keep working", () => {
    // Critical invariant: in-memory provider instances bind their token
    // store to the connectionId at construction time. If we minted a new
    // id on account switch, those providers would silently load null from
    // disk and fail at the next chat() call. Keep the id stable; just
    // replace the account fields.
    const store: ConnectionStore = {
      connections: [
        {
          id: "old-conn",
          provider: "openai-chatgpt",
          label: "ChatGPT (a@example.com)",
          apiKey: "",
          chatgptAccount: { id: "acct-A", email: "a@example.com", accessToken: "at-A", refreshToken: "rt-A", expiresAtMs: 1 },
          models: [{ id: "gpt-5.5", displayName: "GPT-5.5", available: true }],
          source: "oauth",
          addedAt: "",
        },
        {
          id: "anth-conn",
          provider: "anthropic",
          label: "Anthropic",
          apiKey: "sk-ant",
          models: [{ id: "claude", displayName: "Claude", available: true }],
          source: "manual",
          addedAt: "",
        },
      ],
      tierAssignments: {
        large: { connectionId: "old-conn", modelId: "gpt-5.5" },
        medium: { connectionId: "anth-conn", modelId: "claude" },
        small: { connectionId: "old-conn", modelId: "gpt-deprecated" },
      },
    };
    const result = upsertChatGptConnection(store, freshAccount({ id: "acct-B", email: "b@example.com" }), [
      { id: "gpt-5.5", displayName: "GPT-5.5", available: true },
    ]);
    expect(result.replacedInPlace).toBe(true);
    expect(result.connectionId).toBe("old-conn");
    expect(result.removedIds).toEqual([]);
    // Account fields fully replaced, no leakage from acct-A.
    const kept = store.connections.find((c) => c.id === "old-conn");
    expect(kept?.chatgptAccount?.id).toBe("acct-B");
    expect(kept?.chatgptAccount?.email).toBe("b@example.com");
    expect(kept?.chatgptAccount?.accessToken).toBe("at-new");
    // Default-form label refreshed.
    expect(kept?.label).toBe("ChatGPT (b@example.com)");
    // Tier assignments untouched (connectionId is stable).
    expect(store.tierAssignments.large).toEqual({ connectionId: "old-conn", modelId: "gpt-5.5" });
    expect(store.tierAssignments.medium).toEqual({ connectionId: "anth-conn", modelId: "claude" });
    expect(store.tierAssignments.small).toEqual({ connectionId: "old-conn", modelId: "gpt-deprecated" });
  });

  it("dedupes multiple legacy chatgpt connections by keeping one record and dropping the rest", () => {
    const store: ConnectionStore = {
      connections: [
        {
          id: "dup-1", provider: "openai-chatgpt", label: "Old 1", apiKey: "",
          chatgptAccount: { id: "acct-A", accessToken: "x", refreshToken: "y", expiresAtMs: 1 },
          models: [], source: "oauth", addedAt: "",
        },
        {
          id: "dup-2", provider: "openai-chatgpt", label: "Old 2", apiKey: "",
          chatgptAccount: { id: "acct-A", accessToken: "x2", refreshToken: "y2", expiresAtMs: 2 },
          models: [], source: "oauth", addedAt: "",
        },
      ],
      tierAssignments: { large: null, medium: null, small: null },
    };
    const result = upsertChatGptConnection(store, freshAccount({ id: "acct-A" }), []);
    expect(result.replacedInPlace).toBe(true);
    expect(store.connections.map((c) => c.id)).toEqual([result.connectionId]);
    // The kept one's tokens were refreshed
    expect(store.connections[0].chatgptAccount?.accessToken).toBe("at-new");
  });
});
