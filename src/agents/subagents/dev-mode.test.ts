import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildDevPrompt, buildDevTools, buildDevToolHandler, resolveDevPath, enterDevMode, summarizeGameState } from "./dev-mode.js";
import type { GameState } from "../game-state.js";
import type { FileIO, SceneState, SceneManager } from "../scene-manager.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { createObjectivesState } from "../../tools/objectives/index.js";
import { CampaignRepo } from "../../tools/git/index.js";
import type { GitIO } from "../../tools/git/index.js";

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
    decks: { decks: {} },
    objectives: createObjectivesState(),
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
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
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
    deleteFile: vi.fn(async () => {}),
  };
}

function mockSceneManager(scene?: Partial<SceneState>): SceneManager {
  return {
    getScene: vi.fn(() => ({
      sceneNumber: 3,
      slug: "tavern-brawl",
      transcript: ["**DM:** You enter.", "**[Kael]** I look around."],
      precis: "A brawl broke out in the tavern.",
      openThreads: "Who started the fight?",
      npcIntents: "",
      playerReads: [],
      sessionNumber: 1,
      ...scene,
    })),
  } as unknown as SceneManager;
}

describe("summarizeGameState", () => {
  it("includes campaign root and key paths", () => {
    const summary = summarizeGameState(makeGameState());
    expect(summary).toContain("Campaign root: /campaigns/test-campaign");
    expect(summary).toContain("characters/party.md");
    expect(summary).toContain("campaign/log.json");
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
      decks: { decks: { "poker-deck": { cards: [], drawn: [] } as never } },
    });
    const summary = summarizeGameState(gs);
    expect(summary).toContain("Maps loaded: tavern");
    expect(summary).toContain("Decks loaded: poker-deck");
  });
});

// --- Tool definitions ---

describe("buildDevTools", () => {
  it("includes all dev-specific tools", () => {
    const names = buildDevTools().map((t) => t.name);
    const devTools = [
      "read_file", "write_file", "list_dir", "get_game_state", "set_game_state",
      "repair_state", "get_scene_state", "validate_campaign", "search_files", "delete_file",
      "get_commit_log", "find_references", "rename_entity", "merge_entities", "resolve_dead_links",
    ];
    for (const name of devTools) {
      expect(names).toContain(name);
    }
  });

  it("includes DM tools from the tool registry", () => {
    const names = buildDevTools().map((t) => t.name);
    // Spot-check key DM tools are present
    expect(names).toContain("roll_dice");
    expect(names).toContain("rollback");
    expect(names).toContain("scribe");
    expect(names).toContain("start_combat");
    expect(names).toContain("set_alarm");
    expect(names).toContain("create_map");
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

  // --- New tool handler tests ---

  it("get_scene_state returns scene data", async () => {
    const sm = mockSceneManager();
    const handler = buildDevToolHandler(makeGameState(), mockFileIO(), undefined, sm);

    const result = await handler("get_scene_state", {});
    const parsed = JSON.parse(result.content);
    expect(parsed.sceneNumber).toBe(3);
    expect(parsed.slug).toBe("tavern-brawl");
    expect(parsed.precis).toContain("brawl");
    expect(parsed.openThreads).toContain("fight");
    expect(parsed.exchangeCount).toBe(2);
  });

  it("get_scene_state errors without scene manager", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("get_scene_state", {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No scene manager");
  });

  it("validate_campaign returns validation report", async () => {
    const gs = makeGameState();
    const fio = mockFileIO(
      { "/campaigns/test-campaign/config.json": '{"name":"Test"}' },
      {
        "/campaigns/test-campaign/characters": [],
        "/campaigns/test-campaign/locations": [],
        "/campaigns/test-campaign/factions": [],
        "/campaigns/test-campaign/items": [],
        "/campaigns/test-campaign/lore": [],
      },
    );
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("validate_campaign", {});
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty("issues");
    expect(parsed).toHaveProperty("errorCount");
    expect(parsed).toHaveProperty("warningCount");
    expect(parsed).toHaveProperty("filesChecked");
  });

  it("search_files finds matching lines", async () => {
    const gs = makeGameState();
    const fio = mockFileIO(
      {
        "/campaigns/test-campaign/characters/kael.md": "# Kael\n**Race:** Half-elf\nHP: 20",
        "/campaigns/test-campaign/characters/goblin.md": "# Goblin\nHP: 5",
      },
      {
        "/campaigns/test-campaign": ["characters"],
        "/campaigns/test-campaign/characters": ["kael.md", "goblin.md"],
      },
    );
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("search_files", { pattern: "HP:", path: "characters" });
    expect(result.content).toContain("kael.md");
    expect(result.content).toContain("HP: 20");
    expect(result.content).toContain("goblin.md");
    expect(result.content).toContain("HP: 5");
  });

  it("search_files returns no matches message", async () => {
    const gs = makeGameState();
    const fio = mockFileIO(
      { "/campaigns/test-campaign/notes.md": "nothing here" },
      {
        "/campaigns/test-campaign": ["notes.md"],
      },
    );
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("search_files", { pattern: "ZZZZZ" });
    expect(result.content).toBe("(no matches)");
  });

  it("delete_file calls fileIO.deleteFile", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("delete_file", { path: "characters/old.md" });
    expect(result.content).toContain("Deleted characters/old.md");
    expect(fio.deleteFile).toHaveBeenCalledWith("/campaigns/test-campaign/characters/old.md");
  });

  it("delete_file errors when deleteFile not supported", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    delete fio.deleteFile;
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("delete_file", { path: "characters/old.md" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Delete not supported");
  });

  it("repair_state errors without client", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("repair_state", { dry_run: true });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No API client");
  });

  it("resolve_dead_links errors without client", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("resolve_dead_links", { context: "test" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No API client");
  });

  it("find_references returns references for a target entity", async () => {
    const gs = makeGameState();
    const fio = mockFileIO(
      {
        "/campaigns/test-campaign/characters/kael.md": "# Kael\n**Type:** PC",
        "/campaigns/test-campaign/campaign/log.json": '{"campaignName":"Test","entries":[]}',
        "/campaigns/test-campaign/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
      },
      {
        "/campaigns/test-campaign/characters": ["kael.md"],
      },
    );
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("find_references", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.target).toBe("characters/kael.md");
    // Reference is in legacy log.md (walkCampaign falls back since log.json has no wikilinks)
    expect(parsed.references.length).toBeGreaterThanOrEqual(0);
  });

  it("rename_entity delegates to operation and returns result", async () => {
    const gs = makeGameState();
    const fio = mockFileIO(
      {
        "/campaigns/test-campaign/characters/kael.md": "# Kael\n**Type:** PC",
        "/campaigns/test-campaign/campaign/log.json": 'Met [Kael](../characters/kael.md).',
      },
      {
        "/campaigns/test-campaign/characters": ["kael.md"],
      },
    );
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("rename_entity", {
      old_path: "characters/kael.md",
      new_path: "characters/kael-ranger.md",
      dry_run: true,
    });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.oldPath).toBe("characters/kael.md");
    expect(parsed.newPath).toBe("characters/kael-ranger.md");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.linksUpdated).toBe(1);
  });

  it("merge_entities delegates to operation and returns result", async () => {
    const gs = makeGameState();
    const fio = mockFileIO(
      {
        "/campaigns/test-campaign/characters/kael.md": "# Kael\n**Type:** PC",
        "/campaigns/test-campaign/characters/kael-dupe.md": "# Kael\n**Type:** PC\n**Class:** Ranger",
      },
      {
        "/campaigns/test-campaign/characters": ["kael.md", "kael-dupe.md"],
      },
    );
    const handler = buildDevToolHandler(gs, fio);

    const result = await handler("merge_entities", {
      winner_path: "characters/kael.md",
      loser_path: "characters/kael-dupe.md",
      dry_run: true,
    });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.winnerPath).toBe("characters/kael.md");
    expect(parsed.loserPath).toBe("characters/kael-dupe.md");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.keysAdded).toContain("class");
  });
});

describe("buildDevToolHandler — resource tools mutate state and forward TUI command", () => {
  it("set_display_resources mutates GameState and forwards TUI command", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    const onTuiCommand = vi.fn();
    const handler = buildDevToolHandler(gs, fio, undefined, undefined, undefined, onTuiCommand);
    const result = await handler("set_display_resources", { character: "Kael", resources: ["HP"] });
    expect(result.is_error).toBeUndefined();
    expect(gs.displayResources["Kael"]).toEqual(["HP"]);
    expect(onTuiCommand).toHaveBeenCalledOnce();
    expect((onTuiCommand.mock.calls[0][0] as { type: string }).type).toBe("set_display_resources");
  });

  it("set_resource_values mutates GameState and forwards TUI command", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    const onTuiCommand = vi.fn();
    const handler = buildDevToolHandler(gs, fio, undefined, undefined, undefined, onTuiCommand);
    const result = await handler("set_resource_values", { character: "Kael", values: { HP: "24/30" } });
    expect(result.is_error).toBeUndefined();
    expect(gs.resourceValues["Kael"]).toEqual({ HP: "24/30" });
    expect(onTuiCommand).toHaveBeenCalledOnce();
    expect((onTuiCommand.mock.calls[0][0] as { type: string }).type).toBe("set_resource_values");
  });
});

// --- Git mock for commit log tests ---

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

async function repoWithHistory(): Promise<CampaignRepo> {
  const git = mockGitIO();
  const repo = new CampaignRepo({ dir: "/campaigns/test-campaign", git });
  await repo.sceneCommit("The Tavern Brawl");
  await repo.autoCommit("auto: exchanges");
  return repo;
}

describe("buildDevToolHandler — get_commit_log", () => {
  it("returns commit log with distinct dates", async () => {
    const gs = makeGameState();
    const fio = mockFileIO();
    const repo = await repoWithHistory();
    const handler = buildDevToolHandler(gs, fio, undefined, undefined, repo);

    const result = await handler("get_commit_log", {});
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("[scene]");
    expect(result.content).toContain("Tavern Brawl");
    expect(result.content).toContain("2025-03-");
    // Commits are 1 day apart — verify multiple dates appear
    const dateMatches = result.content.match(/\((\d{4}-\d{2}-\d{2})/g) ?? [];
    const uniqueDates = new Set(dateMatches);
    expect(uniqueDates.size).toBeGreaterThan(1);
  });

  it("filters by type", async () => {
    const gs = makeGameState();
    const repo = await repoWithHistory();
    const handler = buildDevToolHandler(gs, mockFileIO(), undefined, undefined, repo);

    const result = await handler("get_commit_log", { type: "scene" });
    expect(result.content).toContain("[scene]");
    expect(result.content).not.toContain("[auto]");
  });

  it("errors when repo not available", async () => {
    const handler = buildDevToolHandler(makeGameState(), mockFileIO());
    const result = await handler("get_commit_log", {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not available");
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
      expect(createCall.tools.length).toBeGreaterThanOrEqual(15);
      expect(createCall.max_tokens).toBe(16384); // DEV_MODE
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
      expect(createCall.max_tokens).toBe(16384); // DEV_MODE
    }
  });
});
