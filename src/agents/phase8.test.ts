import { describe, it, expect, vi } from "vitest";
import type { GameState } from "./game-state.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { CampaignConfig, PlayerConfig } from "../types/config.js";
import {
  getActivePlayer,
  switchToNextPlayer,
  switchToPlayer,
  getCombatActivePlayer,
  isAITurn,
  getPlayerEntries,
} from "./player-manager.js";
import { aiPlayerTurn, buildAIPlayerPrompt } from "./subagents/ai-player.js";
import { enterOOC, buildOOCPrompt } from "./subagents/ooc-mode.js";
import { ToolRegistry } from "./tool-registry.js";

// --- Test Helpers ---

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
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

const humanPlayer: PlayerConfig = {
  name: "Alex",
  character: "Aldric",
  type: "human",
};

const aiPlayer: PlayerConfig = {
  name: "Rook",
  character: "Rook",
  type: "ai",
  model: "haiku",
  personality: "Sardonic, pragmatic, stealth-first. Loyal but always has an exit planned.",
};

const secondHuman: PlayerConfig = {
  name: "Sam",
  character: "Sable",
  type: "human",
};

function makeConfig(players: PlayerConfig[]): CampaignConfig {
  return {
    name: "Test Campaign",
    dm_personality: { name: "Test", prompt_fragment: "Test DM" },
    players,
    combat: {
      initiative_method: "d20_dex",
      round_structure: "individual",
      surprise_rules: false,
    },
    context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
    recovery: { auto_commit_interval: 3, max_commits: 500, enable_git: true },
    choices: { campaign_default: "often", player_overrides: {} },
  };
}

function makeState(players: PlayerConfig[], activeIndex = 0): GameState {
  return {
    maps: {},
    clocks: { calendar: { epoch: "0", current: 0, display_format: "d/m/y", alarms: [] }, combat: { active: false, current: 0, alarms: [] } },
    combat: { active: false, order: [], round: 0, currentTurn: 0 },
    combatConfig: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    decks: { decks: {} },
    config: makeConfig(players),
    campaignRoot: "/tmp/test",
    homeDir: "/tmp/home",
    activePlayerIndex: activeIndex,
    displayResources: {},
    resourceValues: {},
  };
}

// --- Player Manager Tests ---

describe("getActivePlayer", () => {
  it("returns the active player by index", () => {
    const state = makeState([humanPlayer, aiPlayer], 0);
    const active = getActivePlayer(state);
    expect(active.characterName).toBe("Aldric");
    expect(active.isAI).toBe(false);
    expect(active.index).toBe(0);
  });

  it("returns AI player when active", () => {
    const state = makeState([humanPlayer, aiPlayer], 1);
    const active = getActivePlayer(state);
    expect(active.characterName).toBe("Rook");
    expect(active.isAI).toBe(true);
  });

  it("falls back to first player on invalid index", () => {
    const state = makeState([humanPlayer, aiPlayer], 99);
    const active = getActivePlayer(state);
    expect(active.characterName).toBe("Aldric");
    expect(active.index).toBe(0);
  });
});

describe("switchToNextPlayer", () => {
  it("cycles through players", () => {
    const state = makeState([humanPlayer, aiPlayer, secondHuman], 0);

    const next1 = switchToNextPlayer(state);
    expect(next1.characterName).toBe("Rook");
    expect(state.activePlayerIndex).toBe(1);

    const next2 = switchToNextPlayer(state);
    expect(next2.characterName).toBe("Sable");
    expect(state.activePlayerIndex).toBe(2);

    // Wraps around
    const next3 = switchToNextPlayer(state);
    expect(next3.characterName).toBe("Aldric");
    expect(state.activePlayerIndex).toBe(0);
  });

  it("returns same player if only one player", () => {
    const state = makeState([humanPlayer], 0);
    const active = switchToNextPlayer(state);
    expect(active.characterName).toBe("Aldric");
  });
});

describe("switchToPlayer", () => {
  it("switches to a specific player", () => {
    const state = makeState([humanPlayer, aiPlayer], 0);
    const active = switchToPlayer(state, 1);
    expect(active.characterName).toBe("Rook");
    expect(state.activePlayerIndex).toBe(1);
  });

  it("ignores invalid indices", () => {
    const state = makeState([humanPlayer, aiPlayer], 0);
    const active = switchToPlayer(state, -1);
    expect(active.characterName).toBe("Aldric");
  });
});

describe("getCombatActivePlayer", () => {
  it("returns player matching current combatant", () => {
    const state = makeState([humanPlayer, aiPlayer], 0);
    state.combat = {
      active: true,
      order: [
        { id: "Rook", initiative: 19, type: "ai_pc" },
        { id: "Aldric", initiative: 14, type: "pc" },
      ],
      round: 1,
      currentTurn: 0,
    };

    const player = getCombatActivePlayer(state);
    expect(player).not.toBeNull();
    expect(player!.characterName).toBe("Rook");
    expect(player!.isAI).toBe(true);
    expect(state.activePlayerIndex).toBe(1);
  });

  it("returns null for NPC turns", () => {
    const state = makeState([humanPlayer], 0);
    state.combat = {
      active: true,
      order: [
        { id: "G1", initiative: 17, type: "npc" },
        { id: "Aldric", initiative: 14, type: "pc" },
      ],
      round: 1,
      currentTurn: 0,
    };

    const player = getCombatActivePlayer(state);
    expect(player).toBeNull();
  });

  it("returns null when combat is inactive", () => {
    const state = makeState([humanPlayer], 0);
    expect(getCombatActivePlayer(state)).toBeNull();
  });
});

describe("isAITurn", () => {
  it("returns true when active player is AI", () => {
    const state = makeState([humanPlayer, aiPlayer], 1);
    expect(isAITurn(state)).toBe(true);
  });

  it("returns false when active player is human", () => {
    const state = makeState([humanPlayer, aiPlayer], 0);
    expect(isAITurn(state)).toBe(false);
  });

  it("checks combat turn during active combat", () => {
    const state = makeState([humanPlayer, aiPlayer], 0);
    state.combat = {
      active: true,
      order: [{ id: "Rook", initiative: 19, type: "ai_pc" }],
      round: 1,
      currentTurn: 0,
    };

    expect(isAITurn(state)).toBe(true);
  });
});

describe("getPlayerEntries", () => {
  it("builds TUI-ready player entries", () => {
    const state = makeState([humanPlayer, aiPlayer, secondHuman]);
    const entries = getPlayerEntries(state);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ name: "Aldric", isAI: false });
    expect(entries[1]).toEqual({ name: "Rook", isAI: true });
    expect(entries[2]).toEqual({ name: "Sable", isAI: false });
  });
});

// --- AI Player Tests ---

describe("buildAIPlayerPrompt", () => {
  it("builds prompt with personality and character sheet", () => {
    const prompt = buildAIPlayerPrompt({
      player: aiPlayer,
      characterSheet: "Rook - Half-elf Rogue, Level 3\nHP: 24/24\nDEX: +3",
      recentNarration: "The DM says the door creaks open...",
    });

    expect(prompt).toContain("Rook");
    expect(prompt).toContain("Sardonic, pragmatic");
    expect(prompt).toContain("Half-elf Rogue");
    expect(prompt).toContain("Do NOT narrate outcomes");
  });

  it("works without personality", () => {
    const plain: PlayerConfig = { name: "Bot", character: "Bot", type: "ai" };
    const prompt = buildAIPlayerPrompt({
      player: plain,
      characterSheet: "Bot - Fighter",
      recentNarration: "...",
    });

    expect(prompt).toContain("Bot");
    expect(prompt).not.toContain("Personality:");
  });

  it("includes situation when provided", () => {
    const prompt = buildAIPlayerPrompt({
      player: aiPlayer,
      characterSheet: "Rook stats",
      recentNarration: "...",
      situation: "In a dark corridor, goblins ahead",
    });

    expect(prompt).toContain("dark corridor");
    expect(prompt).toContain("goblins ahead");
  });
});

describe("aiPlayerTurn", () => {
  it("invokes Haiku and returns action text", async () => {
    const client = mockClient([
      textResponse("I check the shadows near the doorway for traps."),
    ]);

    const result = await aiPlayerTurn(client, {
      player: aiPlayer,
      characterSheet: "Rook - Rogue, DEX +3, Perception +5",
      recentNarration: "The party enters a dusty chamber. Cobwebs hang from the ceiling.",
    });

    expect(result.action).toBe("I check the shadows near the doorway for traps.");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("trims whitespace from response", async () => {
    const client = mockClient([
      textResponse("  I swing my blade.  \n"),
    ]);

    const result = await aiPlayerTurn(client, {
      player: aiPlayer,
      characterSheet: "stats",
      recentNarration: "Your turn.",
    });

    expect(result.action).toBe("I swing my blade.");
  });
});

// --- OOC Mode Tests ---

describe("buildOOCPrompt", () => {
  it("builds base OOC prompt", () => {
    const prompt = buildOOCPrompt("Shattered Crown");
    expect(prompt).toContain("Out-of-Character");
    expect(prompt).toContain("Shattered Crown");
  });

  it("includes system rules when provided", () => {
    const prompt = buildOOCPrompt("Campaign", "Grappling: contested STR check...");
    expect(prompt).toContain("Grappling: contested STR check");
  });

  it("includes character sheet when provided", () => {
    const prompt = buildOOCPrompt("Campaign", undefined, "Aldric - Paladin, HP 42/42");
    expect(prompt).toContain("Aldric - Paladin");
  });
});

describe("enterOOC", () => {
  it("spawns player-facing Sonnet subagent", async () => {
    const client = mockClient([
      textResponse("Grappling works as a contested Athletics check. The grappler rolls STR(Athletics) against the target's STR(Athletics) or DEX(Acrobatics)."),
    ]);

    const onStream = vi.fn();
    const result = await enterOOC(
      client,
      "How does grappling work?",
      {
        campaignName: "Test Campaign",
        previousVariant: "exploration",
      },
      onStream,
    );

    // Uses stream for player-facing
    expect(client.messages.stream).toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
    expect(result.snapshot.previousVariant).toBe("exploration");
    expect(result.usage.inputTokens).toBe(50);
  });

  it("preserves snapshot state", async () => {
    const client = mockClient([textResponse("Sure thing.")]);

    const result = await enterOOC(
      client,
      "Quick question",
      {
        campaignName: "Test",
        previousVariant: "combat",
        wasMidNarration: true,
      },
    );

    expect(result.snapshot.previousVariant).toBe("combat");
    expect(result.snapshot.wasMidNarration).toBe(true);
  });

  it("extracts terse summary from response", async () => {
    const client = mockClient([
      textResponse("The player asked about grappling rules. I explained the contested Athletics check mechanic."),
    ]);

    const result = await enterOOC(client, "grappling?", {
      campaignName: "Test",
      previousVariant: "exploration",
    });

    // Summary should be the first sentence
    expect(result.summary).toBe("The player asked about grappling rules.");
  });
});

// --- Tool Registry Tests ---

describe("new Phase 8 tools", () => {
  it("registers enter_ooc tool", () => {
    const registry = new ToolRegistry();
    expect(registry.has("enter_ooc")).toBe(true);
  });

  it("enter_ooc returns TUI command", () => {
    const state = makeState([humanPlayer]);
    const registry = new ToolRegistry();
    const result = registry.dispatch(state, "enter_ooc", { reason: "Player asked about rules" });

    const cmd = JSON.parse(result.content);
    expect(cmd.type).toBe("enter_ooc");
    expect(cmd.reason).toBe("Player asked about rules");
  });

  it("registers switch_player tool", () => {
    const registry = new ToolRegistry();
    expect(registry.has("switch_player")).toBe(true);
  });

  it("switch_player changes active player index", () => {
    const state = makeState([humanPlayer, aiPlayer]);
    const registry = new ToolRegistry();
    const result = registry.dispatch(state, "switch_player", { player: "Rook" });

    expect(result.content).toContain("Rook");
    expect(state.activePlayerIndex).toBe(1);
  });

  it("switch_player errors on unknown player", () => {
    const state = makeState([humanPlayer]);
    const registry = new ToolRegistry();
    const result = registry.dispatch(state, "switch_player", { player: "Nobody" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("registers resolve_turn tool", () => {
    const registry = new ToolRegistry();
    expect(registry.has("resolve_turn")).toBe(true);
  });

  it("registers promote_character tool", () => {
    const registry = new ToolRegistry();
    expect(registry.has("promote_character")).toBe(true);
  });

  it("registry has 44 tools total", () => {
    const registry = new ToolRegistry();
    expect(registry.size).toBe(44);
  });
});
