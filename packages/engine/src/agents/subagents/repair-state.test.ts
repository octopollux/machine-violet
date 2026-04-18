import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../../providers/types.js";
import { repairState, parseGeneratedEntities } from "./repair-state.js";
import type { GameState } from "../game-state.js";
import type { FileIO } from "../scene-manager.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { createObjectivesState } from "../../tools/objectives/index.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetPromptCache();
});

function makeGameState(root = "/campaigns/test"): GameState {
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
      choices: { campaign_default: "never", player_overrides: {} },
    },
    campaignRoot: root,
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
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
      throw new Error(`ENOENT: ${p}`);
    }),
    deleteFile: vi.fn(async () => {}),
  };
}

function mockUsage(): NormalizedUsage {
  return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResult(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function mockProvider(text: string): LLMProvider {
  return {
    providerId: "test",
    chat: vi.fn(async () => textResult(text)),
    stream: vi.fn(async (_params, onDelta) => {
      const result = textResult(text);
      if (result.text) onDelta(result.text);
      return result;
    }),
    healthCheck: vi.fn(),
  };
}

describe("parseGeneratedEntities", () => {
  it("parses delimited output into entities", () => {
    const output = `Here are the entities:

===characters/kael.md===
# Kael

**Race:** Half-elf

A ranger.

===locations/thornwood.md===
# Thornwood

**Type:** Forest

A dark forest.`;

    const result = parseGeneratedEntities(output);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe("characters/kael.md");
    expect(result[0].content).toContain("# Kael");
    expect(result[1].filePath).toBe("locations/thornwood.md");
    expect(result[1].content).toContain("# Thornwood");
  });

  it("handles empty output", () => {
    expect(parseGeneratedEntities("")).toHaveLength(0);
  });

  it("handles output with no delimiters", () => {
    expect(parseGeneratedEntities("just some text")).toHaveLength(0);
  });
});

describe("repairState", () => {
  it("identifies missing entities from transcripts", async () => {
    const transcript = `# Scene 1

**DM:** You meet [Kael](../characters/kael.md) in the [Thornwood](../locations/thornwood.md).

**[Alice]** I approach Kael.`;

    const fio = mockFileIO(
      {
        "/campaigns/test/campaign/scenes/001-opening/transcript.md": transcript,
      },
      {
        "/campaigns/test/campaign/scenes": ["001-opening"],
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider(
      `===characters/kael.md===
# Kael

**Race:** Unknown

A mysterious figure.

===locations/thornwood/index.md===
# Thornwood

**Type:** Forest

A dark forest.`,
    );

    const result = await repairState(provider, makeGameState(), fio, true);

    expect(result.missing).toContain("characters/kael.md");
    expect(result.missing).toContain("locations/thornwood/index.md");
    expect(result.dryRun).toBe(true);
    expect(result.existing).toHaveLength(0);
  });

  it("skips entities that already exist", async () => {
    const transcript = `**DM:** You see [Kael](../characters/kael.md) and [Goblin](../characters/goblin.md).`;

    const fio = mockFileIO(
      {
        "/campaigns/test/campaign/scenes/001-opening/transcript.md": transcript,
        "/campaigns/test/characters/kael.md": "# Kael\nExisting file.",
      },
      {
        "/campaigns/test/campaign/scenes": ["001-opening"],
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider(
      `===characters/goblin.md===
# Goblin

A hostile creature.`,
    );

    const result = await repairState(provider, makeGameState(), fio, true);

    expect(result.existing).toContain("characters/kael.md");
    expect(result.missing).toContain("characters/goblin.md");
    expect(result.generated).toContain("characters/goblin.md");
  });

  it("does not call writeFile in dry-run mode", async () => {
    const transcript = `**DM:** [Kael](../characters/kael.md) attacks.`;

    const fio = mockFileIO(
      { "/campaigns/test/campaign/scenes/001-opening/transcript.md": transcript },
      {
        "/campaigns/test/campaign/scenes": ["001-opening"],
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider(
      `===characters/kael.md===
# Kael

A fighter.`,
    );

    await repairState(provider, makeGameState(), fio, true);

    expect(fio.writeFile).not.toHaveBeenCalled();
  });

  it("writes files when dry_run is false", async () => {
    const transcript = `**DM:** [Kael](../characters/kael.md) attacks.`;

    const fio = mockFileIO(
      { "/campaigns/test/campaign/scenes/001-opening/transcript.md": transcript },
      {
        "/campaigns/test/campaign/scenes": ["001-opening"],
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider(
      `===characters/kael.md===
# Kael

A fighter.`,
    );

    const result = await repairState(provider, makeGameState(), fio, false);

    expect(fio.writeFile).toHaveBeenCalledWith(
      "/campaigns/test/characters/kael.md",
      expect.stringContaining("# Kael"),
    );
    expect(result.generated).toContain("characters/kael.md");
    expect(result.dryRun).toBe(false);
  });

  it("handles empty transcripts gracefully", async () => {
    const fio = mockFileIO(
      {},
      {
        "/campaigns/test/campaign/scenes": [],
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider("");

    const result = await repairState(provider, makeGameState(), fio, true);

    expect(result.found).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles missing scenes directory gracefully", async () => {
    const fio = mockFileIO(
      {},
      {
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider("");

    const result = await repairState(provider, makeGameState(), fio, true);

    expect(result.found).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  it("accumulates usage stats", async () => {
    const transcript = `**DM:** [Kael](../characters/kael.md) arrives.`;

    const fio = mockFileIO(
      { "/campaigns/test/campaign/scenes/001-opening/transcript.md": transcript },
      {
        "/campaigns/test/campaign/scenes": ["001-opening"],
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
      },
    );

    const provider = mockProvider(
      `===characters/kael.md===
# Kael

A character.`,
    );

    const result = await repairState(provider, makeGameState(), fio, true);

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });
});
