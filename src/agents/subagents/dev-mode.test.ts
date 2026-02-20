import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildDevPrompt, buildDevTools, buildDevToolHandler, resolveDevPath, enterDevMode, summarizeGameState } from "./dev-mode.js";
import type { GameState } from "../game-state.js";
import type { FileIO } from "../scene-manager.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[callIdx++]),
      stream: vi.fn(() => ({
        on: vi.fn(),
        finalMessage: vi.fn(async () => responses[callIdx++]),
      })),
    },
  } as unknown as Anthropic;
}

describe("buildDevPrompt", () => {
  it("includes campaign name", () => {
    const prompt = buildDevPrompt("Shadow of the Dragon");
    expect(prompt).toContain("Campaign: Shadow of the Dragon");
  });

  it("includes game state summary when provided", () => {
    const prompt = buildDevPrompt("Test", "combat active, 3 entities");
    expect(prompt).toContain("Current game state:\ncombat active, 3 entities");
  });

  it("omits optional blocks when absent", () => {
    const prompt = buildDevPrompt("Test");
    expect(prompt).not.toContain("Current game state:");
    expect(prompt).not.toContain("undefined");
  });

  it("contains developer-focused instructions", () => {
    const prompt = buildDevPrompt("Test");
    expect(prompt).toContain("Developer Console");
    expect(prompt).toContain("engine internals");
  });

  it("mentions tools in instructions", () => {
    const prompt = buildDevPrompt("Test");
    expect(prompt).toContain("USE TOOLS");
  });
});

function makeGameState(overrides?: Partial<GameState>): GameState {
  return {
    maps: {},
    clocks: {
      calendar: { current: 0, epoch: "Day 1", display_format: "Day {n}", alarms: [] },
      combat: { current: 0, active: false, alarms: [] },
    },
    combat: { active: false, order: [], round: 0, currentTurn: 0 },
    combatConfig: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    decks: {},
    config: {
      name: "Test Campaign",
      dm_personality: { name: "Classic", prompt_fragment: "" },
      players: [{ name: "Alice", character: "Kael", type: "human" }],
      combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 500 },
      recovery: { auto_commit_interval: 5, max_commits: 100, enable_git: false },
      choices: { campaign_default: "often", player_overrides: {} },
    },
    campaignRoot: "/campaigns/test-campaign",
    activePlayerIndex: 0,
    ...overrides,
  };
}

function mockFileIO(files: Record<string, string> = {}, dirs: Record<string, string[]> = {}): FileIO {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => p in files || p in dirs),
    listDir: vi.fn(async (p: string) => {
      if (p in dirs) return dirs[p];
      return [];
    }),
  };
}

describe("summarizeGameState", () => {
  it("includes campaign root and key paths", () => {
    const summary = summarizeGameState(makeGameState());
    expect(summary).toContain("Campaign root: /campaigns/test-campaign");
    expect(summary).toContain("characters/party.md");
    expect(summary).toContain("campaign/log.md");
    expect(summary).toContain("campaign/scenes/");
  });

  it("lists players with active marker", () => {
    const summary = summarizeGameState(makeGameState());
    expect(summary).toContain("Kael (human, player: Alice) [ACTIVE]");
  });

  it("shows combat state when active", () => {
    const gs = makeGameState({
      combat: {
        active: true,
        round: 3,
        currentTurn: 1,
        order: [
          { id: "kael", initiative: 18, type: "pc" },
          { id: "goblin-1", initiative: 12, type: "npc" },
        ],
      },
    });
    const summary = summarizeGameState(gs);
    expect(summary).toContain("Combat: ACTIVE (round 3)");
    expect(summary).toContain("kael (pc, init 18)");
    expect(summary).toContain("goblin-1 (npc, init 12) ← current");
  });

  it("shows inactive combat", () => {
    const summary = summarizeGameState(makeGameState());
    expect(summary).toContain("Combat: inactive");
  });

  it("shows calendar clock info", () => {
    const gs = makeGameState({
      clocks: {
        calendar: {
          current: 5, epoch: "Day 1", display_format: "Day {n}",
          alarms: [{ id: "dawn", fires_at: 10, message: "Sun rises" }],
        },
        combat: { current: 0, active: false, alarms: [] },
      },
    });
    const summary = summarizeGameState(gs);
    expect(summary).toContain("Calendar clock: tick 5");
    expect(summary).toContain('dawn: fires at 10 — "Sun rises"');
  });

  it("shows loaded maps and decks", () => {
    const gs = makeGameState({
      maps: { tavern: { width: 10, height: 10, terrain: [], tokens: [] } as never },
      decks: { "poker-deck": { cards: [], drawn: [] } as never },
    });
    const summary = summarizeGameState(gs);
    expect(summary).toContain("Maps loaded: tavern");
    expect(summary).toContain("Decks loaded: poker-deck");
  });
});

// --- Tool definitions ---

describe("buildDevTools", () => {
  it("returns 5 tool definitions", () => {
    const tools = buildDevTools();
    expect(tools).toHaveLength(5);
  });

  it("has expected tool names", () => {
    const names = buildDevTools().map((t) => t.name);
    expect(names).toEqual(["read_file", "write_file", "list_dir", "get_game_state", "set_game_state"]);
  });

  it("each tool has name, description, and input_schema", () => {
    for (const tool of buildDevTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeTruthy();
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

// --- Path resolution ---

describe("resolveDevPath", () => {
  it("resolves relative paths under campaign root", () => {
    expect(resolveDevPath("/camp", "characters/kael.md")).toBe("/camp/characters/kael.md");
  });

  it("strips leading slashes", () => {
    expect(resolveDevPath("/camp", "/characters/kael.md")).toBe("/camp/characters/kael.md");
  });

  it("normalizes backslashes", () => {
    expect(resolveDevPath("/camp", "characters\\kael.md")).toBe("/camp/characters/kael.md");
  });

  it("rejects .. traversal", () => {
    expect(() => resolveDevPath("/camp", "../etc/passwd")).toThrow("Path traversal not allowed");
  });

  it("rejects mid-path .. traversal", () => {
    expect(() => resolveDevPath("/camp", "characters/../../etc")).toThrow("Path traversal not allowed");
  });

  it("allows single dots (current dir)", () => {
    expect(resolveDevPath("/camp", "./foo.md")).toBe("/camp/foo.md");
  });
});

// --- Tool handler ---

describe("buildDevToolHandler", () => {
  it("read_file reads from mocked FileIO", async () => {
    const gs = makeGameState();
    const fio = mockFileIO({ "/campaigns/test-campaign/characters/kael.md": "# Kael\nHP: 20" });
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.content).toBe("# Kael\nHP: 20");
    expect(result.is_error).toBeUndefined();
    expect(fio.readFile).toHaveBeenCalledWith("/campaigns/test-campaign/characters/kael.md");
  });

  it("read_file returns error for missing file", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("read_file", { path: "nonexistent.md" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("ENOENT");
  });

  it("write_file writes via mocked FileIO", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("write_file", { path: "notes.md", content: "Hello" });
    expect(result.content).toContain("Wrote notes.md");
    expect(fio.writeFile).toHaveBeenCalledWith("/campaigns/test-campaign/notes.md", "Hello");
  });

  it("list_dir lists directory contents", async () => {
    const gs = makeGameState();
    const fio = mockFileIO({}, { "/campaigns/test-campaign/characters": ["kael.md", "goblin.md"] });
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("list_dir", { path: "characters" });
    expect(result.content).toBe("kael.md\ngoblin.md");
  });

  it("list_dir returns empty directory message", async () => {
    const gs = makeGameState();
    const fio = mockFileIO({}, { "/campaigns/test-campaign": [] });
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("list_dir", { path: "." });
    expect(result.content).toBe("(empty directory)");
  });

  it("get_game_state returns combat slice", async () => {
    const gs = makeGameState({ combat: { active: true, round: 2, currentTurn: 0, order: [] } });
    const handler = buildDevToolHandler(gs, mockFileIO());

    const result = await handler("get_game_state", { slice: "combat" });
    const parsed = JSON.parse(result.content);
    expect(parsed.active).toBe(true);
    expect(parsed.round).toBe(2);
  });

  it("get_game_state returns 'all' without campaignRoot/activePlayerIndex", async () => {
    const gs = makeGameState();
    const handler = buildDevToolHandler(gs, mockFileIO());

    const result = await handler("get_game_state", { slice: "all" });
    const parsed = JSON.parse(result.content);
    expect(parsed.campaignRoot).toBeUndefined();
    expect(parsed.activePlayerIndex).toBeUndefined();
    expect(parsed.combat).toBeDefined();
    expect(parsed.config).toBeDefined();
  });

  it("get_game_state returns config slice", async () => {
    const gs = makeGameState();
    const handler = buildDevToolHandler(gs, mockFileIO());

    const result = await handler("get_game_state", { slice: "config" });
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe("Test Campaign");
  });

  it("get_game_state rejects invalid slice", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("get_game_state", { slice: "invalid" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Unknown slice");
  });

  it("set_game_state patches combat", async () => {
    const gs = makeGameState();
    const handler = buildDevToolHandler(gs, mockFileIO());

    const result = await handler("set_game_state", { slice: "combat", patch: { active: true, round: 5 } });
    expect(result.content).toContain("Patched combat");
    expect(gs.combat.active).toBe(true);
    expect(gs.combat.round).toBe(5);
  });

  it("set_game_state rejects 'all' slice", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("set_game_state", { slice: "all", patch: {} });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Cannot patch 'all'");
  });

  it("rejects path traversal in read_file", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("read_file", { path: "../etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Path traversal not allowed");
  });

  it("rejects path traversal in write_file", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("write_file", { path: "../../evil.sh", content: "bad" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Path traversal not allowed");
  });

  it("returns error for unknown tool", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("nonexistent_tool", {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});

// --- enterDevMode ---

describe("enterDevMode", () => {
  it("returns summary from first sentence", async () => {
    const client = mockClient([textResponse("Combat state has 2 active entities. Both are alive.")]);
    const result = await enterDevMode(client, "show combat state", {
      campaignName: "Test",
    });
    expect(result.summary).toBe("Combat state has 2 active entities.");
  });

  it("truncates summary over 100 chars", async () => {
    const longText = "A".repeat(110) + ". More text here.";
    const client = mockClient([textResponse(longText)]);
    const result = await enterDevMode(client, "dump everything", {
      campaignName: "Test",
    });
    expect(result.summary).toHaveLength(100);
    expect(result.summary).toMatch(/\.\.\.$/);
  });

  it("defaults summary for empty text", async () => {
    const client = mockClient([textResponse("")]);
    const result = await enterDevMode(client, "test", {
      campaignName: "Test",
    });
    expect(result.summary).toBe("Dev mode discussion.");
  });

  it("uses stream when onStream callback provided", async () => {
    const client = mockClient([textResponse("Response.")]);
    const onStream = vi.fn();
    await enterDevMode(client, "question", {
      campaignName: "Test",
    }, onStream);
    expect(client.messages.stream).toHaveBeenCalled();
  });

  it("accumulates usage stats", async () => {
    const client = mockClient([textResponse("Done.")]);
    const result = await enterDevMode(client, "test", {
      campaignName: "Test",
    });
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("passes tools when gameState and fileIO provided", async () => {
    const client = mockClient([textResponse("Done.")]);
    const gs = makeGameState();
    const fio = mockFileIO();

    await enterDevMode(client, "test", {
      campaignName: "Test",
      gameState: gs,
      fileIO: fio,
    });

    // When tools are provided, the create call should include tools
    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(5);
      expect(createCall.max_tokens).toBe(1024); // SUBAGENT_LARGE
    }
  });

  it("works without tools when gameState/fileIO not provided", async () => {
    const client = mockClient([textResponse("Done.")]);
    await enterDevMode(client, "test", {
      campaignName: "Test",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toBeUndefined();
      expect(createCall.max_tokens).toBe(512); // SUBAGENT_MEDIUM
    }
  });
});
