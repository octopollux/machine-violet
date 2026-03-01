import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createMap } from "../tools/maps/index.js";

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    config: {
      name: "Test Campaign",
      dm_personality: { name: "test", prompt_fragment: "You are terse." },
      players: [{ name: "Alice", character: "Aldric", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "often", player_overrides: {} },
    },
    campaignRoot: "/tmp/test-campaign",
    activePlayerIndex: 0,
  };
}

describe("ToolRegistry", () => {
  it("registers all T1 tools", () => {
    const reg = new ToolRegistry();
    // Map (14) + Dice (1) + Deck (1) + Clocks (5) + Combat (4) + TUI (6) = 31
    expect(reg.size).toBeGreaterThanOrEqual(30);
  });

  it("generates API-compatible tool definitions", () => {
    const reg = new ToolRegistry();
    const defs = reg.getDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.input_schema.type).toBe("object");
    }
  });

  it("dispatches roll_dice", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "roll_dice", { expression: "1d6" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1d6");
    expect(result.content).toContain("→");
  });

  it("dispatches deck create + draw", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const create = reg.dispatch(state, "deck", { deck: "test", operation: "create", template: "standard52" });
    expect(create.is_error).toBeUndefined();
    const draw = reg.dispatch(state, "deck", { deck: "test", operation: "draw", count: 3 });
    expect(draw.is_error).toBeUndefined();
    expect(draw.content).toContain("Drew:");
  });

  it("dispatches create_map and view_area", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    reg.dispatch(state, "create_map", {
      id: "dungeon",
      grid_type: "square",
      width: 10,
      height: 10,
      default_terrain: "stone",
    });
    expect(state.maps["dungeon"]).toBeTruthy();

    const view = reg.dispatch(state, "view_area", { map: "dungeon", center: "5,5", radius: 2 });
    expect(view.is_error).toBeUndefined();
    expect(view.content).toContain("."); // default terrain shorthand
  });

  it("dispatches place_entity and move_entity", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    state.maps["m"] = createMap("m", "square", 10, 10, "stone");

    reg.dispatch(state, "place_entity", {
      map: "m",
      coord: "3,3",
      entity: { id: "goblin1", type: "npc" },
    });
    expect(state.maps["m"].entities["3,3"]).toHaveLength(1);

    reg.dispatch(state, "move_entity", { map: "m", entity_id: "goblin1", to: "5,5" });
    expect(state.maps["m"].entities["5,5"]).toHaveLength(1);
    expect(state.maps["m"].entities["3,3"] ?? []).toHaveLength(0);
  });

  it("dispatches set_alarm and check_clocks", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "set_alarm", {
      clock: "calendar",
      in: "2 days",
      message: "Orc warband arrives",
    });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Alarm");

    const check = reg.dispatch(state, "check_clocks", {});
    expect(check.content).toContain("calendar");
  });

  it("dispatches combat lifecycle", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const start = reg.dispatch(state, "start_combat", {
      combatants: [
        { id: "Aldric", type: "pc", modifier: 3 },
        { id: "Goblin", type: "npc", modifier: 1 },
      ],
    });
    expect(start.content).toContain("Combat started");
    expect(state.combat.active).toBe(true);

    const advance = reg.dispatch(state, "advance_turn", {});
    expect(advance.content).toContain("turn");

    const end = reg.dispatch(state, "end_combat", {});
    expect(end.content).toContain("Combat ended");
    expect(state.combat.active).toBe(false);
  });

  it("returns TUI commands as JSON (update_modeline defaults character)", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "update_modeline", { text: "HP: 42/42" });
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("update_modeline");
    expect(parsed.text).toBe("HP: 42/42");
    expect(parsed.character).toBe("Aldric");
  });

  it("update_modeline uses explicit character param", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "update_modeline", { text: "HP: 30/30", character: "Rook" });
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("update_modeline");
    expect(parsed.text).toBe("HP: 30/30");
    expect(parsed.character).toBe("Rook");
  });

  it("returns error for unknown tool", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "nonexistent_tool", {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });

  it("returns error for missing map", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "view_area", { map: "no_such_map", center: "0,0", radius: 1 });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("catches handler exceptions gracefully", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    // roll_dice with invalid expression
    const result = reg.dispatch(state, "roll_dice", { expression: "" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Tool error");
  });

  it("has() returns correct results", () => {
    const reg = new ToolRegistry();
    expect(reg.has("roll_dice")).toBe(true);
    expect(reg.has("fake_tool")).toBe(false);
  });

  it("dispatches define_region and creates region on map", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    state.maps["m"] = createMap("m", "square", 10, 10, "stone");

    const result = reg.dispatch(state, "define_region", {
      map: "m", x1: 1, y1: 1, x2: 3, y2: 3, terrain: "water",
    });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("water");
    expect(state.maps["m"].regions).toHaveLength(1);
    expect(state.maps["m"].regions[0].terrain).toBe("water");
  });

  it("dispatches set_terrain with region input (regression)", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    state.maps["m"] = createMap("m", "square", 10, 10, "stone");

    const result = reg.dispatch(state, "set_terrain", {
      map: "m",
      region: { x1: 0, y1: 0, x2: 2, y2: 2 },
      terrain: "forest",
    });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("forest");
    expect(state.maps["m"].regions).toHaveLength(1);
    expect(state.maps["m"].regions[0].terrain).toBe("forest");
  });

  // ====== WORLDBUILDING ======

  it("create_entity returns TUI command with serialized content (character type)", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "create_entity", {
      entity_type: "character",
      name: "Grimjaw the Bold",
      front_matter: { disposition: "hostile", class: "warrior" },
      body: "A scarred orc chieftain.",
    });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("create_entity");
    expect(parsed.entity_type).toBe("character");
    expect(parsed.name).toBe("Grimjaw the Bold");
    expect(parsed.slug).toBe("grimjaw-the-bold");
    expect(parsed.file_path).toContain("characters");
    expect(parsed.content).toContain("# Grimjaw the Bold");
    expect(parsed.content).toContain("hostile");
    expect(parsed.content).toContain("scarred orc");
  });

  it("create_entity for location uses subdirectory path", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "create_entity", {
      entity_type: "location",
      name: "Iron Forge",
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.file_path).toContain("locations");
    expect(parsed.file_path).toContain("index.md");
  });

  it("create_entity rejects invalid entity_type", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "create_entity", {
      entity_type: "weapon",
      name: "Sword",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Invalid entity_type");
  });

  it("create_entity rejects empty name", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "create_entity", {
      entity_type: "character",
      name: "  ",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("required");
  });

  it("create_entity with minimal input (no body/front_matter)", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "create_entity", {
      entity_type: "faction",
      name: "The Red Hand",
    });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.entity_type).toBe("faction");
    expect(parsed.content).toContain("# The Red Hand");
    expect(parsed.content).toContain("**Type:** faction");
  });

  it("update_entity returns TUI command with update instructions", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "update_entity", {
      entity_type: "character",
      name: "Grimjaw",
      front_matter_updates: { disposition: "friendly" },
      body_append: "Has joined the party.",
      changelog_entry: "Befriended by Aldric",
    });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("update_entity");
    expect(parsed.front_matter_updates).toEqual({ disposition: "friendly" });
    expect(parsed.body_append).toBe("Has joined the party.");
    expect(parsed.changelog_entry).toBe("Befriended by Aldric");
  });

  it("update_entity rejects when no updates provided", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "update_entity", {
      entity_type: "character",
      name: "Grimjaw",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("At least one");
  });

  it("getDefinitionsFor returns only requested tools, skips unknown", () => {
    const reg = new ToolRegistry();
    const defs = reg.getDefinitionsFor(["roll_dice", "nonexistent", "check_clocks"]);
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe("roll_dice");
    expect(defs[1].name).toBe("check_clocks");
  });

  it("getDefinitionsFor returns empty array for all-unknown names", () => {
    const reg = new ToolRegistry();
    const defs = reg.getDefinitionsFor(["fake1", "fake2"]);
    expect(defs).toHaveLength(0);
  });

  it("dispatches context_refresh and returns TUI command JSON", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "context_refresh", {});
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("context_refresh");
  });

  it("dispatches scene_transition and returns TuiCommand JSON", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "scene_transition", { title: "The Dark Forest", time_advance: 60 });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("scene_transition");
    expect(parsed.title).toBe("The Dark Forest");
    expect(parsed.time_advance).toBe(60);
  });

  it("dispatches session_end and returns TuiCommand JSON", () => {
    const reg = new ToolRegistry();
    const state = mockState();
    const result = reg.dispatch(state, "session_end", { title: "End of Session 1" });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe("session_end");
    expect(parsed.title).toBe("End of Session 1");
    expect(parsed.time_advance).toBeUndefined();
  });
});
