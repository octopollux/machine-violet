import { describe, it, expect, beforeEach } from "vitest";
import type { CombatState, CombatConfig, Combatant } from "@machine-violet/shared/types/combat.js";
import {
  createCombatState,
  createDefaultConfig,
  startCombat,
  endCombat,
  advanceTurn,
  getCurrentTurn,
  modifyInitiative,
} from "./index.js";
import { seededRng } from "../dice/index.js";

let state: CombatState;
let config: CombatConfig;

beforeEach(() => {
  state = createCombatState();
  config = createDefaultConfig();
});

const party: Combatant[] = [
  { id: "aldric", type: "pc", modifier: 2 },
  { id: "sable", type: "pc", modifier: 1 },
  { id: "rook", type: "ai_pc", modifier: 4 },
  { id: "G1", type: "npc", modifier: 1 },
  { id: "G2", type: "npc", modifier: -1 },
];

describe("combat state", () => {
  it("creates fresh state", () => {
    expect(state.active).toBe(false);
    expect(state.order).toEqual([]);
    expect(state.round).toBe(0);
    expect(state.currentTurn).toBe(0);
  });
});

describe("startCombat", () => {
  it("starts combat with d20_dex initiative", () => {
    const rng = seededRng(42);
    const result = startCombat(state, { combatants: party }, config, rng);

    expect(state.active).toBe(true);
    expect(state.round).toBe(1);
    expect(result.round).toBe(1);
    expect(result.order).toHaveLength(5);
    // Order is sorted descending by initiative
    for (let i = 0; i < result.order.length - 1; i++) {
      expect(result.order[i].initiative).toBeGreaterThanOrEqual(
        result.order[i + 1].initiative,
      );
    }
  });

  it("is deterministic with seeded RNG", () => {
    const result1 = startCombat(
      createCombatState(),
      { combatants: party },
      config,
      seededRng(99),
    );
    const result2 = startCombat(
      createCombatState(),
      { combatants: party },
      config,
      seededRng(99),
    );
    expect(result1.order).toEqual(result2.order);
  });

  it("throws if combat already active", () => {
    startCombat(state, { combatants: party }, config, seededRng(42));
    expect(() =>
      startCombat(state, { combatants: party }, config, seededRng(42)),
    ).toThrow("already active");
  });

  it("throws with empty combatants", () => {
    expect(() =>
      startCombat(state, { combatants: [] }, config),
    ).toThrow("no combatants");
  });

  it("applies modifiers to d20 rolls", () => {
    const highMod: Combatant[] = [
      { id: "fast", type: "pc", modifier: 100 },
      { id: "slow", type: "npc", modifier: -100 },
    ];
    const result = startCombat(state, { combatants: highMod }, config, seededRng(42));
    expect(result.order[0].id).toBe("fast");
    expect(result.order[1].id).toBe("slow");
  });
});

describe("initiative methods", () => {
  it("fiction_first preserves input order with no rolling", () => {
    config.initiative_method = "fiction_first";
    const combatants: Combatant[] = [
      { id: "first", type: "pc" },
      { id: "second", type: "npc" },
      { id: "third", type: "ai_pc" },
    ];
    const result = startCombat(state, { combatants }, config);
    expect(result.order[0].id).toBe("first");
    expect(result.order[1].id).toBe("second");
    expect(result.order[2].id).toBe("third");
  });

  it("fiction_first respects pre-set initiative values", () => {
    config.initiative_method = "fiction_first";
    const combatants: Combatant[] = [
      { id: "A", type: "pc", initiative: 5 },
      { id: "B", type: "npc", initiative: 10 },
    ];
    const result = startCombat(state, { combatants }, config);
    expect(result.order[0].initiative).toBe(5);
    expect(result.order[1].initiative).toBe(10);
  });

  it("custom sorts by provided initiative values", () => {
    config.initiative_method = "custom";
    const combatants: Combatant[] = [
      { id: "low", type: "pc", initiative: 3 },
      { id: "high", type: "npc", initiative: 18 },
      { id: "mid", type: "pc", initiative: 10 },
    ];
    const result = startCombat(state, { combatants }, config);
    expect(result.order[0].id).toBe("high");
    expect(result.order[1].id).toBe("mid");
    expect(result.order[2].id).toBe("low");
  });

  it("card_draw rolls random initiative", () => {
    config.initiative_method = "card_draw";
    const combatants: Combatant[] = [
      { id: "A", type: "pc" },
      { id: "B", type: "npc" },
    ];
    const result = startCombat(state, { combatants }, config, seededRng(42));
    expect(result.order).toHaveLength(2);
    // Both should have initiative values
    for (const entry of result.order) {
      expect(entry.initiative).toBeGreaterThan(0);
    }
  });
});

describe("turn management", () => {
  beforeEach(() => {
    startCombat(state, { combatants: party }, config, seededRng(42));
  });

  it("getCurrentTurn returns first combatant", () => {
    const current = getCurrentTurn(state);
    expect(current.id).toBe(state.order[0].id);
  });

  it("advanceTurn moves to next combatant", () => {
    const first = getCurrentTurn(state);
    const result = advanceTurn(state);
    expect(result.current.id).not.toBe(first.id);
    expect(result.newRound).toBe(false);
    expect(result.round).toBe(1);
  });

  it("advanceTurn wraps around and increments round", () => {
    // Advance through all combatants
    // Advance through all combatants to wrap around
    party.forEach(() => advanceTurn(state));
    // We should be back at the start, round 2
    expect(state.currentTurn).toBe(0);
    expect(state.round).toBe(2);
  });

  it("advanceTurn signals new round", () => {
    // Advance to last combatant
    for (let i = 0; i < party.length - 1; i++) {
      const result = advanceTurn(state);
      expect(result.newRound).toBe(false);
    }
    // One more wraps
    const result = advanceTurn(state);
    expect(result.newRound).toBe(true);
    expect(result.round).toBe(2);
  });

  it("throws when no active combat", () => {
    const fresh = createCombatState();
    expect(() => getCurrentTurn(fresh)).toThrow("No active combat");
    expect(() => advanceTurn(fresh)).toThrow("No active combat");
  });
});

describe("endCombat", () => {
  it("ends active combat", () => {
    startCombat(state, { combatants: party }, config, seededRng(42));
    // Advance a few turns
    advanceTurn(state);
    advanceTurn(state);

    const result = endCombat(state);
    expect(result.rounds).toBe(1);
    expect(result.combat_clock_reset).toBe(true);
    expect(state.active).toBe(false);
    expect(state.order).toEqual([]);
    expect(state.round).toBe(0);
    expect(state.currentTurn).toBe(0);
  });

  it("throws when no active combat", () => {
    expect(() => endCombat(state)).toThrow("No active combat");
  });

  it("reports correct round count after multiple rounds", () => {
    startCombat(state, { combatants: party }, config, seededRng(42));
    // Go through 3 full rounds
    for (let i = 0; i < party.length * 3; i++) {
      advanceTurn(state);
    }
    const result = endCombat(state);
    expect(result.rounds).toBe(4); // started at 1, advanced 3 times
  });
});

describe("modifyInitiative", () => {
  beforeEach(() => {
    startCombat(state, { combatants: party }, config, seededRng(42));
  });

  it("adds a combatant after another", () => {
    const firstId = state.order[0].id;
    const result = modifyInitiative(
      state,
      { action: "add", combatant: "G3", position: `after:${firstId}` },
      config,
    );
    expect(result).toHaveLength(6);
    const g3Idx = result.findIndex((e) => e.id === "G3");
    const firstIdx = result.findIndex((e) => e.id === firstId);
    expect(g3Idx).toBe(firstIdx + 1);
  });

  it("adds a combatant at a specific initiative value", () => {
    const result = modifyInitiative(
      state,
      { action: "add", combatant: "G3", position: "15" },
      config,
    );
    expect(result).toHaveLength(6);
    const g3 = result.find((e) => e.id === "G3");
    expect(g3).toBeDefined();
    expect(g3!.initiative).toBe(15);
  });

  it("adds a combatant with rolled initiative (no position)", () => {
    const result = modifyInitiative(
      state,
      { action: "add", combatant: "G3" },
      config,
      seededRng(77),
    );
    expect(result).toHaveLength(6);
    expect(result.find((e) => e.id === "G3")).toBeDefined();
  });

  it("throws when adding duplicate combatant", () => {
    expect(() =>
      modifyInitiative(
        state,
        { action: "add", combatant: state.order[0].id },
        config,
      ),
    ).toThrow("already in initiative");
  });

  it("removes a combatant", () => {
    const toRemove = state.order[2].id;
    const result = modifyInitiative(
      state,
      { action: "remove", combatant: toRemove },
      config,
    );
    expect(result).toHaveLength(4);
    expect(result.find((e) => e.id === toRemove)).toBeUndefined();
  });

  it("throws when removing nonexistent combatant", () => {
    expect(() =>
      modifyInitiative(
        state,
        { action: "remove", combatant: "nobody" },
        config,
      ),
    ).toThrow("not found");
  });

  it("adjusts currentTurn when removing before it", () => {
    // Advance to turn 3
    advanceTurn(state);
    advanceTurn(state);
    advanceTurn(state);
    const beforeRemove = state.currentTurn;
    const removeId = state.order[0].id; // Remove someone before current
    modifyInitiative(state, { action: "remove", combatant: removeId }, config);
    expect(state.currentTurn).toBe(beforeRemove - 1);
  });

  it("moves a combatant to after another", () => {
    const moverId = state.order[0].id;
    const targetId = state.order[3].id;
    const result = modifyInitiative(
      state,
      { action: "move", combatant: moverId, position: `after:${targetId}` },
      config,
    );
    const moverIdx = result.findIndex((e) => e.id === moverId);
    const targetIdx = result.findIndex((e) => e.id === targetId);
    expect(moverIdx).toBe(targetIdx + 1);
  });

  it("moves a combatant to a new initiative value", () => {
    const moverId = state.order[state.order.length - 1].id;
    const result = modifyInitiative(
      state,
      { action: "move", combatant: moverId, position: "99" },
      config,
    );
    expect(result[0].id).toBe(moverId);
    expect(result[0].initiative).toBe(99);
  });

  it("delays the current combatant", () => {
    const currentId = state.order[0].id;
    const nextId = state.order[1].id;
    const result = modifyInitiative(
      state,
      { action: "delay", combatant: currentId },
      config,
    );
    // Current should now be after next
    const currentIdx = result.findIndex((e) => e.id === currentId);
    const nextIdx = result.findIndex((e) => e.id === nextId);
    expect(currentIdx).toBe(nextIdx + 1);
  });

  it("throws when non-current combatant tries to delay", () => {
    const nonCurrent = state.order[2].id;
    expect(() =>
      modifyInitiative(
        state,
        { action: "delay", combatant: nonCurrent },
        config,
      ),
    ).toThrow("Only the current combatant can delay");
  });

  it("throws when modifying without active combat", () => {
    const fresh = createCombatState();
    expect(() =>
      modifyInitiative(
        fresh,
        { action: "remove", combatant: "anyone" },
        config,
      ),
    ).toThrow("No active combat");
  });
});

describe("tie-breaking", () => {
  it("PCs win ties over NPCs", () => {
    config.initiative_method = "custom";
    const combatants: Combatant[] = [
      { id: "goblin", type: "npc", initiative: 15 },
      { id: "hero", type: "pc", initiative: 15 },
    ];
    const result = startCombat(state, { combatants }, config);
    expect(result.order[0].id).toBe("hero");
    expect(result.order[1].id).toBe("goblin");
  });

  it("AI PCs break ties between PCs and NPCs", () => {
    config.initiative_method = "custom";
    const combatants: Combatant[] = [
      { id: "goblin", type: "npc", initiative: 10 },
      { id: "bot", type: "ai_pc", initiative: 10 },
      { id: "hero", type: "pc", initiative: 10 },
    ];
    const result = startCombat(state, { combatants }, config);
    expect(result.order[0].id).toBe("hero");
    expect(result.order[1].id).toBe("bot");
    expect(result.order[2].id).toBe("goblin");
  });
});
