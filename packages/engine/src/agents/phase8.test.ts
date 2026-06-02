import { describe, it, expect, vi } from "vitest";
import type { GameState } from "./game-state.js";
import type { LLMProvider, ChatResult } from "../providers/types.js";
import type { CampaignConfig, PlayerConfig } from "@machine-violet/shared/types/config.js";
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
import { createTestRegistry } from "./tool-registry.js";
import { createObjectivesState } from "../tools/objectives/index.js";

// --- Test Helpers ---

function mockUsage() {
  return { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResponse(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function mockProvider(responses: ChatResult[]): LLMProvider {
  let callIdx = 0;
  return {
    providerId: "mock",
    chat: vi.fn(async () => responses[callIdx++]),
    stream: vi.fn(async () => responses[callIdx++]),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
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
    // Clone slots so swap_pc (which mutates players in place, mirroring a
    // freshly-parsed config per session) can't leak into the shared module-
    // level player constants across tests.
    players: players.map((p) => ({ ...p })),
    combat: {
      initiative_method: "d20_dex",
      round_structure: "individual",
      surprise_rules: false,
    },
    context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
    recovery: { auto_commit_interval: 3, max_commits: 500, enable_git: true },
    choices: { campaign_default: "never", player_overrides: {} },
  };
}

function makeState(players: PlayerConfig[], activeIndex = 0): GameState {
  return {
    maps: {},
    clocks: { calendar: { epoch: "0", current: 0, display_format: "d/m/y", alarms: [] }, combat: { active: false, current: 0, alarms: [] } },
    combat: { active: false, order: [], round: 0, currentTurn: 0 },
    combatConfig: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    decks: { decks: {} },
    objectives: createObjectivesState(),
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
    const provider = mockProvider([
      textResponse("I check the shadows near the doorway for traps."),
    ]);

    const result = await aiPlayerTurn(provider, {
      player: aiPlayer,
      characterSheet: "Rook - Rogue, DEX +3, Perception +5",
      recentNarration: "The party enters a dusty chamber. Cobwebs hang from the ceiling.",
    }, "claude-haiku-4-5-20251001");

    expect(result.action).toBe("I check the shadows near the doorway for traps.");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("trims whitespace from response", async () => {
    const provider = mockProvider([
      textResponse("  I swing my blade.  \n"),
    ]);

    const result = await aiPlayerTurn(provider, {
      player: aiPlayer,
      characterSheet: "stats",
      recentNarration: "Your turn.",
    }, "claude-haiku-4-5-20251001");

    expect(result.action).toBe("I swing my blade.");
  });
});

// --- OOC Mode Tests ---

describe("buildOOCPrompt", () => {
  it("builds base OOC prompt", () => {
    const prompt = buildOOCPrompt({ campaignName: "Shattered Crown" });
    expect(prompt).toContain("Out-of-Character");
    expect(prompt).toContain("Shattered Crown");
  });

  it("includes system rules when provided", () => {
    const prompt = buildOOCPrompt({
      campaignName: "Campaign",
      systemRules: "Grappling: contested STR check...",
    });
    expect(prompt).toContain("Grappling: contested STR check");
  });

  it("includes character sheet when provided", () => {
    const prompt = buildOOCPrompt({
      campaignName: "Campaign",
      characterSheet: "Aldric - Paladin, HP 42/42",
    });
    expect(prompt).toContain("Aldric - Paladin");
  });
});

describe("enterOOC", () => {
  it("spawns player-facing Sonnet subagent", async () => {
    const provider = mockProvider([
      textResponse("Grappling works as a contested Athletics check. The grappler rolls STR(Athletics) against the target's STR(Athletics) or DEX(Acrobatics)."),
    ]);

    const onStream = vi.fn();
    const result = await enterOOC(
      provider,
      "How does grappling work?",
      {
        campaignName: "Test Campaign",
        previousVariant: "exploration",
        model: "claude-sonnet-4-6",
      },
      onStream,
    );

    // Uses stream for player-facing
    expect(provider.stream).toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
    expect(result.snapshot.previousVariant).toBe("exploration");
    expect(result.usage.inputTokens).toBe(50);
  });

  it("preserves snapshot state", async () => {
    const provider = mockProvider([textResponse("Sure thing.")]);

    const result = await enterOOC(
      provider,
      "Quick question",
      {
        campaignName: "Test",
        previousVariant: "combat",
        wasMidNarration: true,
        model: "claude-sonnet-4-6",
      },
    );

    expect(result.snapshot.previousVariant).toBe("combat");
    expect(result.snapshot.wasMidNarration).toBe(true);
  });

  it("extracts terse summary from response", async () => {
    const provider = mockProvider([
      textResponse("The player asked about grappling rules. I explained the contested Athletics check mechanic."),
    ]);

    const result = await enterOOC(provider, "grappling?", {
      campaignName: "Test",
      previousVariant: "exploration",
      model: "claude-sonnet-4-6",
    });

    // Summary should be the first sentence
    expect(result.summary).toBe("The player asked about grappling rules.");
  });
});

// --- Tool Registry Tests ---

describe("new Phase 8 tools", () => {
  it("registers enter_ooc tool", () => {
    const registry = createTestRegistry();
    expect(registry.has("enter_ooc")).toBe(true);
  });

  it("enter_ooc returns TUI command", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "enter_ooc", { reason: "Player asked about rules" });

    const cmd = JSON.parse(result.content);
    expect(cmd.type).toBe("enter_ooc");
    expect(cmd.reason).toBe("Player asked about rules");
  });

  it("registers switch_player tool", () => {
    const registry = createTestRegistry();
    expect(registry.has("switch_player")).toBe(true);
  });

  it("switch_player changes active player index", () => {
    const state = makeState([humanPlayer, aiPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "switch_player", { player: "Rook" });

    expect(result.content).toContain("Rook");
    expect(state.activePlayerIndex).toBe(1);
  });

  it("switch_player errors on unknown player", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "switch_player", { player: "Nobody" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("switch_player's unknown-player error points at swap_pc", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "switch_player", { player: "Maren" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("swap_pc");
  });

  it("swap_pc reassigns the active slot to a character not in the roster", () => {
    const state = makeState([humanPlayer]); // Alex plays Aldric
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "swap_pc", { character: "Maren", color: "#b33f5d" });

    expect(result.is_error).toBeFalsy();
    expect(state.config.players[0].character).toBe("Maren");
    expect(state.config.players[0].color).toBe("#b33f5d");
    expect(state.config.players[0].name).toBe("Alex"); // player label unchanged
    expect(state.activePlayerIndex).toBe(0);
  });

  it("swap_pc with `replaces` targets the slot controlling that character", () => {
    const state = makeState([humanPlayer, secondHuman], 0); // Alex/Aldric, Sam/Sable
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "swap_pc", { character: "Vesper", replaces: "Sable" });

    expect(result.is_error).toBeFalsy();
    expect(state.config.players[0].character).toBe("Aldric"); // untouched
    expect(state.config.players[1].character).toBe("Vesper");
    expect(state.activePlayerIndex).toBe(1); // active follows the swap
  });

  it("swap_pc errors when `replaces` names no current PC", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "swap_pc", { character: "Maren", replaces: "Ghost" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Ghost");
  });

  it("swap_pc tolerates an out-of-range activePlayerIndex", () => {
    const state = makeState([humanPlayer], 5); // index past the end
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "swap_pc", { character: "Maren" });

    expect(result.is_error).toBeFalsy();
    expect(state.config.players[0].character).toBe("Maren");
    expect(state.activePlayerIndex).toBe(0);
  });

  it("swap_pc can relabel the human player", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    registry.dispatch(state, "swap_pc", { character: "Maren", player_name: "Beep" });

    expect(state.config.players[0].name).toBe("Beep");
    expect(state.config.players[0].character).toBe("Maren");
  });

  it("howto_swap_pc returns the playbook and changes nothing", () => {
    const state = makeState([humanPlayer]);
    const before = JSON.stringify(state);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "howto_swap_pc", {});

    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("swap_pc");
    expect(result.content.toLowerCase()).toContain("player character");
    expect(JSON.stringify(state)).toBe(before); // pure knowledge tool
  });

  it("list_dm_personalities returns the bundled persona catalog", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "list_dm_personalities", {});

    expect(result.is_error).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed.personalities)).toBe(true);
    expect(parsed.personalities.length).toBeGreaterThan(0);
    expect(parsed.personalities[0]).toHaveProperty("name");
  });

  it("swap_dm_personality switches to a bundled preset by name", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    // Pull a real preset name from the catalog so the test isn't brittle.
    const catalog = JSON.parse(
      registry.dispatch(state, "list_dm_personalities", {}).content,
    ).personalities as { name: string }[];
    const target = catalog[0].name;

    const result = registry.dispatch(state, "swap_dm_personality", { name: target });
    expect(result.is_error).toBeFalsy();
    expect(state.config.dm_personality.name).toBe(target);
    expect(state.config.dm_personality.prompt_fragment.length).toBeGreaterThan(0);
    // Reminds the caller about the required in-fiction handoff.
    expect(result.content.toLowerCase()).toContain("handoff");
  });

  it("swap_dm_personality invents a custom persona from a prompt_fragment", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "swap_dm_personality", {
      name: "The Lighthouse Keeper",
      prompt_fragment: "You are The Lighthouse Keeper. You narrate in slow, salt-worn sentences.",
      detail: "Signature: end scenes on a distant light.",
    });

    expect(result.is_error).toBeFalsy();
    expect(state.config.dm_personality.name).toBe("The Lighthouse Keeper");
    expect(state.config.dm_personality.detail).toContain("distant light");
  });

  it("swap_dm_personality errors on an unknown preset with no prompt_fragment", () => {
    const state = makeState([humanPlayer]);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "swap_dm_personality", { name: "Nobody In The List" });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("prompt_fragment");
  });

  it("howto_swap_dm_personality returns the playbook and changes nothing", () => {
    const state = makeState([humanPlayer]);
    const before = JSON.stringify(state);
    const registry = createTestRegistry();
    const result = registry.dispatch(state, "howto_swap_dm_personality", {});

    expect(result.is_error).toBeFalsy();
    expect(result.content.toLowerCase()).toContain("handoff");
    expect(JSON.stringify(state)).toBe(before); // pure knowledge tool
  });

  it("registers resolve_turn tool", () => {
    const registry = createTestRegistry();
    expect(registry.has("resolve_turn")).toBe(true);
  });

  it("registers promote_character tool", () => {
    const registry = createTestRegistry();
    expect(registry.has("promote_character")).toBe(true);
  });

  it("registry has 40 tools total", () => {
    const registry = createTestRegistry();
    // Bumped from 29 → 35 by the entity-tool rework: entity, describe_entity_type,
    // list_entity_types, validate_entity, find_schema_drift, detect_orphans.
    // 35 → 37 by the PC-swap work: swap_pc, howto_swap_pc.
    // 37 → 40 by the DM-personality work: list_dm_personalities,
    // swap_dm_personality, howto_swap_dm_personality.
    expect(registry.size).toBe(40);
  });
});
