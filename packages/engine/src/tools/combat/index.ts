import type {
  Combatant,
  CombatConfig,
  CombatState,
  InitiativeEntry,
  StartCombatInput,
  StartCombatOutput,
  ModifyInitiativeInput,
  EndCombatOutput,
  AdvanceTurnOutput,
} from "@machine-violet/shared/types/combat.js";
import type { RNG } from "../dice/rng.js";
import { cryptoRng } from "../dice/rng.js";
import { parseExpression } from "../dice/parser.js";
import { evaluate } from "../dice/evaluator.js";

export { createDefaultConfig } from "./config.js";

// --- State ---

/** Create a fresh combat state */
export function createCombatState(): CombatState {
  return {
    active: false,
    order: [],
    round: 0,
    currentTurn: 0,
  };
}

// --- Core Operations ---

/** Start combat: roll initiative, sort order, activate */
export function startCombat(
  state: CombatState,
  input: StartCombatInput,
  config: CombatConfig,
  rng: RNG = cryptoRng,
): StartCombatOutput {
  if (state.active) {
    throw new Error("Combat is already active");
  }

  if (input.combatants.length === 0) {
    throw new Error("Cannot start combat with no combatants");
  }

  const order = rollInitiative(input.combatants, config, rng);

  state.active = true;
  state.order = order;
  state.round = 1;
  state.currentTurn = 0;

  return { order: [...order], round: 1 };
}

/** End combat: clear state */
export function endCombat(state: CombatState): EndCombatOutput {
  if (!state.active) {
    throw new Error("No active combat");
  }

  const rounds = state.round;
  state.active = false;
  state.order = [];
  state.round = 0;
  state.currentTurn = 0;

  return { rounds, combat_clock_reset: true };
}

/** Advance to the next turn. Returns the new current combatant. */
export function advanceTurn(state: CombatState): AdvanceTurnOutput {
  if (!state.active) {
    throw new Error("No active combat");
  }
  if (state.order.length === 0) {
    throw new Error("No combatants in initiative order");
  }

  let newRound = false;
  state.currentTurn++;

  if (state.currentTurn >= state.order.length) {
    state.currentTurn = 0;
    state.round++;
    newRound = true;
  }

  return {
    current: { ...state.order[state.currentTurn] },
    newRound,
    round: state.round,
  };
}

/** Get the current combatant */
export function getCurrentTurn(state: CombatState): InitiativeEntry {
  if (!state.active) {
    throw new Error("No active combat");
  }
  if (state.order.length === 0) {
    throw new Error("No combatants in initiative order");
  }
  return { ...state.order[state.currentTurn] };
}

// --- Initiative Modification ---

/** Modify the initiative order mid-combat */
export function modifyInitiative(
  state: CombatState,
  input: ModifyInitiativeInput,
  config: CombatConfig,
  rng: RNG = cryptoRng,
): InitiativeEntry[] {
  if (!state.active) {
    throw new Error("No active combat");
  }

  switch (input.action) {
    case "add":
      return addCombatant(state, input, config, rng);
    case "remove":
      return removeCombatant(state, input.combatant);
    case "move":
      return moveCombatant(state, input);
    case "delay":
      return delayCombatant(state, input.combatant);
    default:
      throw new Error(`Unknown action: ${input.action as string}`);
  }
}

// --- Initiative Rolling ---

function rollInitiative(
  combatants: Combatant[],
  config: CombatConfig,
  rng: RNG,
): InitiativeEntry[] {
  switch (config.initiative_method) {
    case "d20_dex":
      return rollD20Initiative(combatants, rng);
    case "card_draw":
      return cardDrawInitiative(combatants, rng);
    case "fiction_first":
      return fictionFirstInitiative(combatants);
    case "custom":
      return customInitiative(combatants);
    default:
      throw new Error(
        `Unknown initiative method: ${config.initiative_method as string}`,
      );
  }
}

function rollD20Initiative(
  combatants: Combatant[],
  rng: RNG,
): InitiativeEntry[] {
  const expr = parseExpression("1d20");
  const entries: InitiativeEntry[] = combatants.map((c) => {
    const roll = evaluate(expr, rng);
    return {
      id: c.id,
      initiative: roll.total + (c.modifier ?? 0),
      type: c.type,
    };
  });

  // Sort descending by initiative (ties broken by type: pc > ai_pc > npc)
  return sortByInitiative(entries);
}

function cardDrawInitiative(
  combatants: Combatant[],
  rng: RNG,
): InitiativeEntry[] {
  // Draw a "card value" 1-52 for each combatant (higher is better)
  // Real card_draw would use the deck system; this is a standalone fallback
  const entries: InitiativeEntry[] = combatants.map((c) => {
    const value = rng.int(1, 52);
    return {
      id: c.id,
      initiative: value + (c.modifier ?? 0),
      type: c.type,
    };
  });

  return sortByInitiative(entries);
}

function fictionFirstInitiative(
  combatants: Combatant[],
): InitiativeEntry[] {
  // No mechanical rolling. Use pre-set initiative or arrival order.
  return combatants.map((c, i) => ({
    id: c.id,
    initiative: c.initiative ?? (combatants.length - i),
    type: c.type,
  }));
}

function customInitiative(
  combatants: Combatant[],
): InitiativeEntry[] {
  // DM provides initiative values directly
  const entries: InitiativeEntry[] = combatants.map((c) => ({
    id: c.id,
    initiative: c.initiative ?? 0,
    type: c.type,
  }));

  return sortByInitiative(entries);
}

function typePriority(type: string): number {
  if (type === "pc") return 0;
  if (type === "ai_pc") return 1;
  return 2;
}

function sortByInitiative(entries: InitiativeEntry[]): InitiativeEntry[] {
  return entries.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return typePriority(a.type) - typePriority(b.type);
  });
}

// --- Modify Helpers ---

function addCombatant(
  state: CombatState,
  input: ModifyInitiativeInput,
  config: CombatConfig,
  rng: RNG,
): InitiativeEntry[] {
  const existing = state.order.find((e) => e.id === input.combatant);
  if (existing) {
    throw new Error(`Combatant already in initiative: ${input.combatant}`);
  }

  if (input.position?.startsWith("after:")) {
    const afterId = input.position.slice(6);
    const afterIdx = state.order.findIndex((e) => e.id === afterId);
    if (afterIdx === -1) {
      throw new Error(`Combatant not found: ${afterId}`);
    }
    const entry: InitiativeEntry = {
      id: input.combatant,
      initiative: state.order[afterIdx].initiative,
      type: "npc",
    };
    state.order.splice(afterIdx + 1, 0, entry);
    // Adjust currentTurn if insertion was before it
    if (afterIdx + 1 <= state.currentTurn) {
      state.currentTurn++;
    }
  } else if (input.position !== undefined) {
    // Numeric initiative value
    const initValue = parseInt(input.position, 10);
    if (isNaN(initValue)) {
      throw new Error(`Invalid position: ${input.position}`);
    }
    const entry: InitiativeEntry = {
      id: input.combatant,
      initiative: initValue,
      type: "npc",
    };
    // Insert in sorted position
    const insertIdx = state.order.findIndex((e) => e.initiative < initValue);
    const idx = insertIdx === -1 ? state.order.length : insertIdx;
    state.order.splice(idx, 0, entry);
    if (idx <= state.currentTurn) {
      state.currentTurn++;
    }
  } else {
    // Roll initiative for the new combatant
    const combatant: Combatant = { id: input.combatant, type: "npc" };
    const [entry] = rollInitiative([combatant], config, rng);
    const insertIdx = state.order.findIndex(
      (e) => e.initiative < entry.initiative,
    );
    const idx = insertIdx === -1 ? state.order.length : insertIdx;
    state.order.splice(idx, 0, entry);
    if (idx <= state.currentTurn) {
      state.currentTurn++;
    }
  }

  return state.order.map((e) => ({ ...e }));
}

function removeCombatant(
  state: CombatState,
  combatantId: string,
): InitiativeEntry[] {
  const idx = state.order.findIndex((e) => e.id === combatantId);
  if (idx === -1) {
    throw new Error(`Combatant not found: ${combatantId}`);
  }

  state.order.splice(idx, 1);

  // Adjust currentTurn
  if (state.order.length === 0) {
    state.currentTurn = 0;
  } else if (idx < state.currentTurn) {
    state.currentTurn--;
  } else if (idx === state.currentTurn && state.currentTurn >= state.order.length) {
    state.currentTurn = 0;
  }

  return state.order.map((e) => ({ ...e }));
}

function moveCombatant(
  state: CombatState,
  input: ModifyInitiativeInput,
): InitiativeEntry[] {
  const idx = state.order.findIndex((e) => e.id === input.combatant);
  if (idx === -1) {
    throw new Error(`Combatant not found: ${input.combatant}`);
  }

  if (!input.position) {
    throw new Error("Move action requires a position");
  }

  const entry = state.order.splice(idx, 1)[0];

  // Adjust currentTurn for the removal
  const wasCurrent = idx === state.currentTurn;
  if (idx < state.currentTurn) {
    state.currentTurn--;
  }

  if (input.position.startsWith("after:")) {
    const afterId = input.position.slice(6);
    const afterIdx = state.order.findIndex((e) => e.id === afterId);
    if (afterIdx === -1) {
      throw new Error(`Combatant not found: ${afterId}`);
    }
    state.order.splice(afterIdx + 1, 0, entry);
    if (afterIdx + 1 <= state.currentTurn) {
      state.currentTurn++;
    }
  } else {
    const initValue = parseInt(input.position, 10);
    if (isNaN(initValue)) {
      throw new Error(`Invalid position: ${input.position}`);
    }
    entry.initiative = initValue;
    const insertIdx = state.order.findIndex((e) => e.initiative < initValue);
    const newIdx = insertIdx === -1 ? state.order.length : insertIdx;
    state.order.splice(newIdx, 0, entry);
    if (newIdx <= state.currentTurn && !wasCurrent) {
      state.currentTurn++;
    }
  }

  return state.order.map((e) => ({ ...e }));
}

function delayCombatant(
  state: CombatState,
  combatantId: string,
): InitiativeEntry[] {
  const idx = state.order.findIndex((e) => e.id === combatantId);
  if (idx === -1) {
    throw new Error(`Combatant not found: ${combatantId}`);
  }

  if (idx !== state.currentTurn) {
    throw new Error("Only the current combatant can delay");
  }

  // Move to after the next combatant
  if (state.order.length < 2) {
    return state.order.map((e) => ({ ...e })); // Can't delay with only 1 combatant
  }

  const entry = state.order.splice(idx, 1)[0];
  // Insert after the next person (who is now at idx since we removed)
  const insertAt = idx < state.order.length ? idx + 1 : 0;
  state.order.splice(insertAt, 0, entry);

  // currentTurn stays pointing at the same index (the person who was next is now current)
  // No adjustment needed since we removed at idx and insert at idx+1

  return state.order.map((e) => ({ ...e }));
}
