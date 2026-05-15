import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConnectionStore, saveConnectionStore, buildEffectiveConnections,
} from "./connections.js";
import type { AIConnection } from "./connections.js";

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
});
