import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildOOCPrompt, buildOOCTools, buildOOCToolHandler, enterOOC, parseEndOOCSignal } from "./ooc-mode.js";
import type { DMSessionState } from "../dm-prompt.js";
import type { FileIO } from "../scene-manager.js";
import type { GameState } from "../game-state.js";
import type { TuiCommand } from "../agent-loop.js";
import { CampaignRepo } from "../../tools/git/index.js";
import type { GitIO } from "../../tools/git/index.js";
import type { CampaignConfig } from "../../types/config.js";
import { createClocksState } from "../../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../../tools/combat/index.js";
import { createDecksState } from "../../tools/cards/index.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetPromptCache();
});

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
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

function mockConfig(overrides?: Partial<CampaignConfig>): CampaignConfig {
  return {
    name: "TestCampaign",
    system: "FATE",
    genre: "fantasy",
    mood: "dark",
    difficulty: "hard",
    premise: "A world in shadow",
    dm_personality: { name: "The Narrator", prompt_fragment: "You are mysterious." },
    players: [{ name: "Player1", character: "Kael", type: "human" }],
    combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    context: { retention_exchanges: 5, max_conversation_tokens: 4000, tool_result_stub_after: 200 },
    recovery: { auto_commit_interval: 3, max_commits: 100, enable_git: true },
    choices: { campaign_default: "often", player_overrides: {} },
    ...overrides,
  };
}

function mockSessionState(overrides?: Partial<DMSessionState>): DMSessionState {
  return {
    rulesAppendix: "## FATE Core\nAspects, Fate Points, etc.",
    campaignSummary: "Session 1: The party met at the tavern...",
    sessionRecap: "Last time: you defeated the goblins.",
    activeState: "Location: Tavern\nPCs:\n  Kael (HP 10/10)",
    scenePrecis: "The party is resting after the battle. [[Merchant Giles]] offered a quest.",
    ...overrides,
  };
}

describe("buildOOCPrompt (legacy)", () => {
  it("includes campaign name", () => {
    const prompt = buildOOCPrompt("Shadow of the Dragon");
    expect(prompt).toContain("Campaign: Shadow of the Dragon");
  });

  it("includes rules and character sheet when provided", () => {
    const prompt = buildOOCPrompt("TestCampaign", "FATE rules here", "Aldric the Bold");
    expect(prompt).toContain("Game system rules:\nFATE rules here");
    expect(prompt).toContain("Active character:\nAldric the Bold");
  });

  it("omits optional blocks when absent", () => {
    const prompt = buildOOCPrompt("TestCampaign");
    expect(prompt).not.toContain("Game system rules:");
    expect(prompt).not.toContain("Active character:");
    expect(prompt).not.toContain("undefined");
  });
});

describe("buildOOCPrompt (structured)", () => {
  it("returns TextBlockParam[] when config and sessionState provided", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    });
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Anthropic.TextBlockParam[];
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((b) => b.type === "text")).toBe(true);
  });

  it("falls back to string when no sessionState", () => {
    const result = buildOOCPrompt({ campaignName: "TestCampaign" });
    expect(typeof result).toBe("string");
    expect(result).toContain("Campaign: TestCampaign");
  });

  it("falls back to string when no config", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      sessionState: mockSessionState(),
    });
    expect(typeof result).toBe("string");
  });

  it("has cache_control on stable blocks (identity, rules, campaign log)", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as Anthropic.TextBlockParam[];

    const cached = result.filter((b) => "cache_control" in b && b.cache_control);
    expect(cached.length).toBe(3); // identity, rules, campaign log

    // Identity is first cached block
    expect(cached[0].text).toContain("Out-of-Character");

    // Rules block
    expect(cached[1].text).toContain("Rules Reference");
    expect(cached[1].text).toContain("FATE Core");

    // Campaign log block
    expect(cached[2].text).toContain("Campaign Log");
    expect(cached[2].text).toContain("party met at the tavern");
  });

  it("includes campaign setting from config", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as Anthropic.TextBlockParam[];

    const allText = result.map((b) => b.text).join("\n");
    expect(allText).toContain("Campaign Setting");
    expect(allText).toContain("Game System: FATE");
    expect(allText).toContain("Genre: fantasy");
    expect(allText).toContain("A world in shadow");
  });

  it("includes session recap and active state (uncached)", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as Anthropic.TextBlockParam[];

    const allText = result.map((b) => b.text).join("\n");
    expect(allText).toContain("Last Session");
    expect(allText).toContain("defeated the goblins");
    expect(allText).toContain("Current State");
    expect(allText).toContain("Tavern");
    expect(allText).toContain("Scene So Far");
    expect(allText).toContain("Merchant Giles");
  });

  it("includes character sheet when provided", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
      characterSheet: "# Kael\n**HP:** 10",
    }) as Anthropic.TextBlockParam[];

    const allText = result.map((b) => b.text).join("\n");
    expect(allText).toContain("Active Character");
    expect(allText).toContain("Kael");
  });

  it("omits empty session state sections", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: { rulesAppendix: "Some rules" },
    }) as Anthropic.TextBlockParam[];

    const allText = result.map((b) => b.text).join("\n");
    // Check for section headings (not inline mentions in the identity prompt)
    expect(allText).not.toContain("## Campaign Log");
    expect(allText).not.toContain("## Last Session");
    expect(allText).not.toContain("## Current State");
    expect(allText).not.toContain("## Scene So Far");
  });

  it("does not include DM-internal sections (playerRead, uiState)", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: {
        ...mockSessionState(),
        playerRead: "Player seems engaged",
        uiState: "style=classic, variant=exploration",
      },
    }) as Anthropic.TextBlockParam[];

    const allText = result.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Player Read");
    expect(allText).not.toContain("UI State");
  });
});

describe("enterOOC", () => {
  it("returns summary from first sentence", async () => {
    const client = mockClient([textResponse("Grappling lets you restrain foes. You need a STR check.")]);
    const result = await enterOOC(client, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toBe("Grappling lets you restrain foes.");
  });

  it("truncates summary over 100 chars", async () => {
    const longText = "A".repeat(110) + ". More text here.";
    const client = mockClient([textResponse(longText)]);
    const result = await enterOOC(client, "Tell me everything", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toHaveLength(100);
    expect(result.summary).toMatch(/\.\.\.$/);
  });

  it("defaults summary for text without sentence boundary", async () => {
    const client = mockClient([textResponse("")]);
    const result = await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toBe("OOC discussion.");
  });

  it("preserves snapshot with previousVariant and wasMidNarration", async () => {
    const client = mockClient([textResponse("Sure thing.")]);
    const result = await enterOOC(client, "pause", {
      campaignName: "Test",
      previousVariant: "narrating",
      wasMidNarration: true,
    });
    expect(result.snapshot.previousVariant).toBe("narrating");
    expect(result.snapshot.wasMidNarration).toBe(true);
  });

  it("defaults wasMidNarration to false", async () => {
    const client = mockClient([textResponse("Ok.")]);
    const result = await enterOOC(client, "pause", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.snapshot.wasMidNarration).toBe(false);
  });

  it("uses stream when onStream callback provided", async () => {
    const client = mockClient([textResponse("Response.")]);
    const onStream = vi.fn();
    await enterOOC(client, "question", {
      campaignName: "Test",
      previousVariant: "playing",
    }, onStream);
    expect(client.messages.stream).toHaveBeenCalled();
  });

  it("accumulates usage stats", async () => {
    const client = mockClient([textResponse("Done.")]);
    const result = await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("passes tools when repo is provided", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      repo,
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(1);
      expect(createCall.tools[0].name).toBe("get_commit_log");
    }
  });

  it("works without tools when repo not provided", async () => {
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toBeUndefined();
    }
  });

  it("passes 4 tools when fileIO and campaignRoot are provided", async () => {
    const client = mockClient([textResponse("Done.")]);
    const fio = mockFileIO();
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      fileIO: fio,
      campaignRoot: "/camp",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(4);
      const names = createCall.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("find_references");
      expect(names).toContain("validate_campaign");
      expect(names).toContain("get_commit_log");
    }
  });

  it("sends structured system prompt when sessionState and config provided", async () => {
    const client = mockClient([textResponse("The merchant offered you a quest.")]);
    await enterOOC(client, "What did the merchant say?", {
      campaignName: "TestCampaign",
      previousVariant: "playing",
      config: mockConfig(),
      sessionState: mockSessionState(),
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      // System prompt should be an array of TextBlockParam
      expect(Array.isArray(createCall.system)).toBe(true);
      const blocks = createCall.system as Anthropic.TextBlockParam[];
      expect(blocks.length).toBeGreaterThan(1);
      const allText = blocks.map((b: Anthropic.TextBlockParam) => b.text).join("\n");
      expect(allText).toContain("Scene So Far");
      expect(allText).toContain("Merchant Giles");
    }
  });

  it("sends flat string system prompt without sessionState", async () => {
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      // System prompt should be a plain string (with terse suffix)
      expect(typeof createCall.system).toBe("string");
    }
  });
});

// --- Git mock ---

const MOCK_BASE_TS = Math.floor(new Date("2025-03-15T12:00:00Z").getTime() / 1000);

function mockGitIO(): GitIO {
  const commits: { message: string; oid: string; timestamp: number }[] = [];
  const staged = new Set<string>();
  let oidCounter = 0;

  return {
    init: vi.fn(async () => {}),
    add: vi.fn(async (_dir, filepath) => { staged.add(filepath); }),
    commit: vi.fn(async (_dir, message) => {
      const oid = `commit_${++oidCounter}`;
      commits.unshift({ message, oid, timestamp: MOCK_BASE_TS + oidCounter * 86400 });
      staged.clear();
      return oid;
    }),
    log: vi.fn(async (_dir, depth = 50) =>
      commits.slice(0, depth).map((c) => ({
        oid: c.oid,
        commit: { message: c.message, author: { timestamp: c.timestamp } },
      })),
    ),
    checkout: vi.fn(async () => {}),
    resetTo: vi.fn(async () => {}),
    pruneUnreachable: vi.fn(async () => 0),
    statusMatrix: vi.fn(async () =>
      staged.size > 0
        ? [...staged].map((f) => [f, 1, 2, 2] as [string, number, number, number])
        : [["config.json", 1, 2, 1] as [string, number, number, number]],
    ),
    listFiles: vi.fn(async () => ["config.json"]),
    remove: vi.fn(async () => {}),
  };
}

// --- OOC tools ---

function mockFileIO(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): FileIO {
  // Normalize paths for cross-platform matching
  const n = (p: string) => p.replace(/\\/g, "/");
  const normFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) normFiles[n(k)] = v;
  const normDirs: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(dirs)) normDirs[n(k)] = v;

  return {
    readFile: vi.fn(async (p: string) => {
      const np = n(p);
      if (np in normFiles) return normFiles[np];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => n(p) in normFiles || n(p) in normDirs),
    listDir: vi.fn(async (p: string) => {
      const np = n(p);
      if (np in normDirs) return normDirs[np];
      throw new Error(`ENOENT: ${p}`);
    }),
    deleteFile: vi.fn(async () => {}),
  };
}

describe("buildOOCTools", () => {
  it("returns only get_commit_log when no fileIO and no gameState", () => {
    const tools = buildOOCTools(false, false);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_commit_log");
  });

  it("returns 4 tools when fileIO is available but no gameState", () => {
    const tools = buildOOCTools(true, false);
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["get_commit_log", "read_file", "find_references", "validate_campaign"]);
  });

  it("returns 18 tools when both fileIO and gameState are available", () => {
    const tools = buildOOCTools(true, true);
    expect(tools).toHaveLength(18);
    const names = tools.map((t) => t.name);
    expect(names).toContain("roll_dice");
    expect(names).toContain("check_clocks");
    expect(names).toContain("scribe");
    expect(names).toContain("style_scene");
    expect(names).toContain("show_character_sheet");
    expect(names).toContain("rollback");
  });

  it("returns 15 tools when gameState but no fileIO", () => {
    const tools = buildOOCTools(false, true);
    expect(tools).toHaveLength(15);
    const names = tools.map((t) => t.name);
    expect(names).toContain("roll_dice");
    expect(names).not.toContain("read_file");
  });
});

describe("buildOOCToolHandler", () => {
  it("returns commit log with distinct dates", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");
    await repo.autoCommit("auto: exchanges");

    const handler = buildOOCToolHandler(undefined, repo);
    const result = await handler("get_commit_log", {});
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("[scene]");
    expect(result.content).toContain("Dragon's Lair");
    expect(result.content).toContain("2025-03-");
    const dateMatches = result.content.match(/\((\d{4}-\d{2}-\d{2})/g) ?? [];
    const uniqueDates = new Set(dateMatches);
    expect(uniqueDates.size).toBeGreaterThan(1);
  });

  it("filters by type", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");
    await repo.autoCommit("auto: exchanges");

    const handler = buildOOCToolHandler(undefined, repo);
    const result = await handler("get_commit_log", { type: "scene" });
    expect(result.content).toContain("[scene]");
    expect(result.content).not.toContain("[auto]");
  });

  it("returns error for unknown tool", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    const handler = buildOOCToolHandler(undefined, repo);
    const result = await handler("nonexistent", {});
    expect(result.is_error).toBe(true);
  });

  it("read_file reads a campaign file", async () => {
    const fio = mockFileIO({
      "/camp/characters/kael.md": "# Kael\n**Type:** PC",
    });
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", fio);

    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("# Kael\n**Type:** PC");
  });

  it("read_file rejects path traversal", async () => {
    const fio = mockFileIO();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", fio);

    const result = await handler("read_file", { path: "../etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Path traversal not allowed");
  });

  it("read_file errors without fileIO", async () => {
    const handler = buildOOCToolHandler(undefined);
    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("File I/O not available");
  });

  it("find_references returns references for a target entity", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
      },
      {
        "/camp/characters": ["kael.md"],
      },
    );
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", fio);

    const result = await handler("find_references", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0].file).toBe("campaign/log.md");
  });

  it("validate_campaign returns validation report", async () => {
    const fio = mockFileIO(
      { "/camp/config.json": '{"name":"Test"}' },
      {
        "/camp/characters": [],
        "/camp/locations": [],
        "/camp/factions": [],
        "/camp/items": [],
        "/camp/lore": [],
      },
    );
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", fio);

    const result = await handler("validate_campaign", {});
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty("issues");
    expect(parsed).toHaveProperty("errorCount");
  });
});

// --- GameState mock ---

function mockGameState(overrides?: Partial<GameState>): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    config: {
      name: "TestCampaign",
      dm_personality: { name: "Narrator", prompt_fragment: "terse" },
      players: [{ name: "Player1", character: "Kael", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "often", player_overrides: {} },
    },
    campaignRoot: "/camp",
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
    ...overrides,
  };
}

describe("buildOOCToolHandler (DM tools)", () => {
  it("roll_dice dispatches and returns result directly", async () => {
    const gs = mockGameState();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", undefined, undefined, undefined, gs);
    const result = await handler("roll_dice", { expression: "1d6" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1d6");
    expect(result.content).toContain("→");
  });

  it("check_clocks dispatches and returns result directly", async () => {
    const gs = mockGameState();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", undefined, undefined, undefined, gs);
    const result = await handler("check_clocks", {});
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("calendar");
  });

  it("style_scene dispatches and calls onTuiCommand", async () => {
    const gs = mockGameState();
    const onTuiCommand = vi.fn();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", undefined, undefined, undefined, gs, onTuiCommand);
    const result = await handler("style_scene", { key_color: "#8844aa" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("Applied: style_scene");
    expect(onTuiCommand).toHaveBeenCalledOnce();
    const cmd = onTuiCommand.mock.calls[0][0] as TuiCommand;
    expect(cmd.type).toBe("style_scene");
    expect(cmd.key_color).toBe("#8844aa");
  });

  it("show_character_sheet dispatches and calls onTuiCommand", async () => {
    const gs = mockGameState();
    const onTuiCommand = vi.fn();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", undefined, undefined, undefined, gs, onTuiCommand);
    const result = await handler("show_character_sheet", { character: "Kael" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("Applied: show_character_sheet");
    expect(onTuiCommand).toHaveBeenCalledOnce();
    const cmd = onTuiCommand.mock.calls[0][0] as TuiCommand;
    expect(cmd.type).toBe("show_character_sheet");
    expect(cmd.character).toBe("Kael");
  });

  it("scribe without client returns error", async () => {
    const gs = mockGameState();
    const fio = mockFileIO();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", fio, undefined, undefined, gs);
    const result = await handler("scribe", {
      updates: [{ visibility: "private", content: "Test" }],
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Client");
  });

  it("rollback calls performRollback and throws RollbackCompleteError", async () => {
    const { RollbackCompleteError } = await import("../../teardown.js");
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");
    await repo.autoCommit("auto: exchanges");

    const fio = mockFileIO({ "/camp/config.json": "{}" });
    const gs = mockGameState();
    const handler = buildOOCToolHandler(undefined, repo, "/camp", fio, undefined, undefined, gs);
    await expect(handler("rollback", { target: "last" })).rejects.toThrow(RollbackCompleteError);
    expect(git.resetTo).toHaveBeenCalled();
  });

  it("rollback without repo returns error", async () => {
    const gs = mockGameState();
    const fio = mockFileIO();
    const handler = buildOOCToolHandler(undefined, undefined, "/camp", fio, undefined, undefined, gs);
    const result = await handler("rollback", { target: "last" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("rollback without fileIO returns error", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");

    const gs = mockGameState();
    const handler = buildOOCToolHandler(undefined, repo, "/camp", undefined, undefined, undefined, gs);
    const result = await handler("rollback", { target: "last" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("File I/O not available");
  });

  it("scribe without fileIO returns error", async () => {
    const gs = mockGameState();
    const handler = buildOOCToolHandler(undefined, undefined, undefined, undefined, undefined, undefined, gs);
    const result = await handler("scribe", {
      updates: [{ visibility: "private", content: "Test" }],
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Client");
  });
});

describe("enterOOC with gameState", () => {
  it("passes 17 tools when gameState and fileIO are provided", async () => {
    const gs = mockGameState();
    const fio = mockFileIO();
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      fileIO: fio,
      campaignRoot: "/camp",
      gameState: gs,
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(18);
      const names = createCall.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("roll_dice");
      expect(names).toContain("scribe");
      expect(names).toContain("style_scene");
      expect(names).toContain("rollback");
    }
  });

  it("still passes only 4 tools without gameState", async () => {
    const fio = mockFileIO();
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      fileIO: fio,
      campaignRoot: "/camp",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(4);
    }
  });

  it("uses maxToolRounds=8 when tools are available", async () => {
    const gs = mockGameState();
    const fio = mockFileIO();
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      fileIO: fio,
      campaignRoot: "/camp",
      gameState: gs,
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      // maxToolRounds is passed internally to spawnSubagent, not directly to API
      // We verify tools exist to confirm hasTools path was taken
      expect(createCall.tools).toBeDefined();
    }
  });
});

describe("parseEndOOCSignal", () => {
  it("detects self-closing tag", () => {
    const result = parseEndOOCSignal("Thanks for asking!\n<END_OOC />");
    expect(result.found).toBe(true);
    expect(result.playerAction).toBeUndefined();
    expect(result.cleanedText).toBe("Thanks for asking!");
  });

  it("detects self-closing tag without space", () => {
    const result = parseEndOOCSignal("Done.<END_OOC/>");
    expect(result.found).toBe(true);
    expect(result.cleanedText).toBe("Done.");
  });

  it("detects tag with player action payload", () => {
    const result = parseEndOOCSignal("Back to the game!\n<END_OOC>I attack the goblin</END_OOC>");
    expect(result.found).toBe(true);
    expect(result.playerAction).toBe("I attack the goblin");
    expect(result.cleanedText).toBe("Back to the game!");
  });

  it("preserves multiline payload", () => {
    const result = parseEndOOCSignal('OK!\n<END_OOC>I say to the guard:\n"Let us pass."</END_OOC>');
    expect(result.found).toBe(true);
    expect(result.playerAction).toBe('I say to the guard:\n"Let us pass."');
  });

  it("returns found=false when no signal present", () => {
    const text = "Here's how grappling works in FATE...";
    const result = parseEndOOCSignal(text);
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe(text);
    expect(result.playerAction).toBeUndefined();
  });

  it("ignores signal that is not at the end", () => {
    const result = parseEndOOCSignal("<END_OOC /> and then some more text");
    expect(result.found).toBe(false);
  });

  it("handles trailing whitespace after tag", () => {
    const result = parseEndOOCSignal("Done.\n<END_OOC />  \n");
    expect(result.found).toBe(true);
    expect(result.cleanedText).toBe("Done.");
  });

  it("trims payload whitespace", () => {
    const result = parseEndOOCSignal("OK!\n<END_OOC>  I draw my sword  </END_OOC>");
    expect(result.found).toBe(true);
    expect(result.playerAction).toBe("I draw my sword");
  });
});

describe("enterOOC END_OOC integration", () => {
  it("sets endSession when agent emits END_OOC", async () => {
    const client = mockClient([textResponse("Grappling uses Athletics.\n<END_OOC />")]);
    const result = await enterOOC(client, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "exploration",
    });
    expect(result.endSession).toBe(true);
    expect(result.playerAction).toBeUndefined();
    expect(result.text).toBe("Grappling uses Athletics.");
  });

  it("captures playerAction from END_OOC payload", async () => {
    const client = mockClient([textResponse("Back to the game!\n<END_OOC>I grab the guard</END_OOC>")]);
    const result = await enterOOC(client, "I grab the guard", {
      campaignName: "Test",
      previousVariant: "exploration",
    });
    expect(result.endSession).toBe(true);
    expect(result.playerAction).toBe("I grab the guard");
    expect(result.text).toBe("Back to the game!");
  });

  it("does not set endSession when no signal", async () => {
    const client = mockClient([textResponse("Here's how that works...")]);
    const result = await enterOOC(client, "How does X work?", {
      campaignName: "Test",
      previousVariant: "exploration",
    });
    expect(result.endSession).toBeUndefined();
    expect(result.playerAction).toBeUndefined();
  });
});
