import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult } from "../providers/types.js";
import { ResolveSession } from "./resolve-session.js";
import type { GameState } from "./game-state.js";
import type { FileIO } from "./scene-manager.js";
import { norm } from "../utils/paths.js";
import { resetPromptCache } from "../prompts/load-prompt.js";
import { loadModelConfig } from "../config/models.js";
import { createObjectivesState } from "../tools/objectives/index.js";

// --- Mocks ---

vi.mock("./subagents/search-content.js", () => ({
  searchContent: vi.fn(async () => ({
    text: "Search result placeholder",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

function mockUsage() {
  return {
    inputTokens: 200, outputTokens: 100,
    cacheReadTokens: 150, cacheCreationTokens: 50,
    reasoningTokens: 0,
  };
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

function toolAndTextResults(
  toolName: string,
  toolInput: Record<string, unknown>,
  text: string,
): ChatResult[] {
  return [
    {
      text: "",
      toolCalls: [{ id: "toolu_1", name: toolName, input: toolInput }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }],
    },
    textResult(text),
  ];
}

let providerCallIdx: number;

function mockProvider(responses: ChatResult[]): LLMProvider {
  providerCallIdx = 0;
  return {
    providerId: "mock",
    chat: vi.fn(async () => responses[providerCallIdx++]),
    stream: vi.fn(async () => responses[providerCallIdx++]),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
}

let files: Record<string, string>;

function mockFileIO(): FileIO {
  return {
    readFile: vi.fn(async (path: string) => {
      const p = norm(path);
      if (!(p in files)) throw new Error(`File not found: ${p}`);
      return files[p];
    }),
    writeFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = content; }),
    appendFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = (files[norm(path)] ?? "") + content; }),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => norm(path) in files),
    listDir: vi.fn(async () => []),
  };
}

function mockState(): GameState {
  return {
    maps: {},
    clocks: { calendar: { epoch: "0", current: 0, display_format: "d/m/y", alarms: [] }, combat: { active: false, current: 0, alarms: [] } },
    combat: {
      active: true,
      order: [
        { id: "Kael", initiative: 18, type: "pc" },
        { id: "Goblin", initiative: 12, type: "npc" },
      ],
      round: 1,
      currentTurn: 0,
    },
    combatConfig: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    decks: { decks: {} },
    objectives: createObjectivesState(),
    config: {
      name: "Test",
      dm_personality: { name: "grim", prompt_fragment: "Be terse." },
      players: [{ name: "Alice", character: "Kael", type: "human" }],
      combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "often", player_overrides: {} },
      system: "test-system",
    },
    campaignRoot: "/tmp/test-campaign",
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
  };
}

// --- Tests ---

beforeEach(() => {
  files = {};
  resetPromptCache();
  loadModelConfig({ reset: true });
});

describe("ResolveSession", () => {
  it("initializes and resolves a single action with structured XML", async () => {
    const xmlResponse = `Resolving Kael's attack.

<resolution>
  <narrative>Kael's longsword bites deep into the goblin.</narrative>
  <rolls>
    <roll expr="1d20+5" reason="Attack roll" result="18" detail="[13]+5=18"/>
    <roll expr="2d6+3" reason="Longsword damage" result="11" detail="[4,4]+3=11"/>
  </rolls>
  <deltas>
    <delta type="hp_change" target="Goblin" amount="-11" damage_type="slashing"/>
  </deltas>
</resolution>`;

    const provider = mockProvider([textResult(xmlResponse)]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);
    await session.initCombat("### Kael\nHP: 35\nSTR: +3", "# Combat\nAttack = d20 + mod");

    const result = await session.resolve({
      actor: "Kael",
      action: "Attack goblin with longsword",
      targets: ["Goblin"],
    });

    expect(result.narrative).toBe("Kael's longsword bites deep into the goblin.");
    expect(result.rolls).toHaveLength(2);
    expect(result.rolls[0].expression).toBe("1d20+5");
    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0].type).toBe("hp_change");
    expect(result.deltas[0].target).toBe("Goblin");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("falls back to raw text when no XML block present", async () => {
    const provider = mockProvider([
      textResult("Kael swings but the goblin dodges. Miss!"),
    ]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);
    await session.initCombat("stats", "rules");

    const result = await session.resolve({
      actor: "Kael",
      action: "Attack goblin",
    });

    // Falls back to full text as narrative, empty deltas
    expect(result.narrative).toBe("Kael swings but the goblin dodges. Miss!");
    expect(result.deltas).toHaveLength(0);
    expect(result.rolls).toHaveLength(0);
  });

  it("accumulates messages across multiple resolve calls", async () => {
    const xml1 = `<resolution>
  <narrative>Hit!</narrative>
  <rolls><roll expr="1d20+5" reason="Attack" result="18" detail="[13]+5=18"/></rolls>
  <deltas><delta type="hp_change" target="Goblin" amount="-8"/></deltas>
</resolution>`;

    const xml2 = `<resolution>
  <narrative>Goblin strikes back!</narrative>
  <rolls><roll expr="1d20+4" reason="Attack" result="15" detail="[11]+4=15"/></rolls>
  <deltas><delta type="hp_change" target="Kael" amount="-5"/></deltas>
</resolution>`;

    const provider = mockProvider([textResult(xml1), textResult(xml2)]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);
    await session.initCombat("stats", "rules");

    // First resolve
    const r1 = await session.resolve({ actor: "Kael", action: "Attack" });
    expect(r1.narrative).toBe("Hit!");
    const msgCount1 = session.messageCount;

    // Second resolve — messages should accumulate
    const r2 = await session.resolve({ actor: "Goblin", action: "Attack Kael" });
    expect(r2.narrative).toBe("Goblin strikes back!");
    expect(session.messageCount).toBeGreaterThan(msgCount1);
  });

  it("records turn history and produces teardown summary", async () => {
    const xml = `<resolution>
  <narrative>Hit!</narrative>
  <rolls></rolls>
  <deltas></deltas>
</resolution>`;

    const provider = mockProvider([textResult(xml)]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);
    await session.initCombat("stats", "rules");

    await session.resolve({ actor: "Kael", action: "Attack" });

    const history = session.getTurnHistory();
    expect(history).toHaveLength(1);
    expect(history[0].actor).toBe("Kael");
    expect(history[0].outcome).toBe("Hit!");

    const summary = session.teardown();
    expect(summary).toContain("Combat summary");
    expect(summary).toContain("Kael");
    expect(summary).toContain("1 turns");
  });

  it("teardown with no turns returns informative message", () => {
    const provider = mockProvider([]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);

    const summary = session.teardown();
    expect(summary).toBe("Combat ended with no resolved turns.");
  });

  it("handles tool use (roll_dice) during resolution", async () => {
    const provider = mockProvider([
      ...toolAndTextResults(
        "roll_dice",
        { expression: "1d20+5", reason: "Attack" },
        `<resolution>
  <narrative>Hit!</narrative>
  <rolls><roll expr="1d20+5" reason="Attack" result="18" detail="[13]+5=18"/></rolls>
  <deltas><delta type="hp_change" target="Goblin" amount="-8"/></deltas>
</resolution>`,
      ),
    ]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);
    await session.initCombat("stats", "rules");

    const result = await session.resolve({ actor: "Kael", action: "Attack" });

    // The tool was called and the final text was parsed
    expect(result.narrative).toBe("Hit!");
    expect(result.deltas).toHaveLength(1);
  });

  it("handles read_character_sheet tool", async () => {
    files[norm("/tmp/test-campaign/characters/Kael.md")] = "# Kael\nHP: 35\nSTR: +3";

    const provider = mockProvider([
      ...toolAndTextResults(
        "read_character_sheet",
        { character: "Kael" },
        `<resolution>
  <narrative>Checked sheet.</narrative>
  <rolls></rolls>
  <deltas></deltas>
</resolution>`,
      ),
    ]);
    const fileIO = mockFileIO();
    const state = mockState();

    const session = new ResolveSession(provider, fileIO, state);
    await session.initCombat("stats", "rules");

    const result = await session.resolve({ actor: "Kael", action: "Check stats" });
    expect(result.narrative).toBe("Checked sheet.");

    // Verify the character sheet was read
    expect(fileIO.readFile).toHaveBeenCalledWith(
      expect.stringContaining("Kael.md"),
    );
  });
});
