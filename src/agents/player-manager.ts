import type { GameState } from "./game-state.js";
import type { PlayerConfig } from "../types/config.js";
import type { CombatantType } from "../types/combat.js";
import { getCurrentTurn } from "../tools/combat/index.js";

/**
 * Active player info — resolved from config + combat state.
 */
export interface ActivePlayer {
  player: PlayerConfig;
  index: number;
  isAI: boolean;
  characterName: string;
}

/**
 * Get the currently active player.
 */
export function getActivePlayer(state: GameState): ActivePlayer {
  const idx = state.activePlayerIndex;
  const player = state.config.players[idx];
  if (!player) {
    // Fallback to first player
    const p = state.config.players[0];
    return { player: p, index: 0, isAI: p.type === "ai", characterName: p.character };
  }
  return { player, index: idx, isAI: player.type === "ai", characterName: player.character };
}

/**
 * Switch to the next human player (Tab key outside combat).
 * Cycles through all players, wrapping around.
 * Returns the new active player.
 */
export function switchToNextPlayer(state: GameState): ActivePlayer {
  const count = state.config.players.length;
  if (count <= 1) return getActivePlayer(state);

  const next = (state.activePlayerIndex + 1) % count;
  state.activePlayerIndex = next;
  return getActivePlayer(state);
}

/**
 * Switch to a specific player by index.
 */
export function switchToPlayer(state: GameState, index: number): ActivePlayer {
  const count = state.config.players.length;
  if (index < 0 || index >= count) {
    return getActivePlayer(state);
  }
  state.activePlayerIndex = index;
  return getActivePlayer(state);
}

/**
 * During combat: determine which player should act based on current turn.
 * Maps the current combatant to a player in the config.
 *
 * Returns the matched player, or null if it's an NPC turn (DM handles it).
 */
export function getCombatActivePlayer(state: GameState): ActivePlayer | null {
  if (!state.combat.active || state.combat.order.length === 0) {
    return null;
  }

  const current = getCurrentTurn(state.combat);
  if (!current) return null;

  // NPCs are DM-controlled — no player switch needed
  if (current.type === "npc") return null;

  // Find the player whose character matches this combatant
  const playerIdx = findPlayerByCombatant(state, current.id, current.type);
  if (playerIdx === -1) return null;

  // Auto-switch to this player
  state.activePlayerIndex = playerIdx;
  return getActivePlayer(state);
}

/**
 * Find a player index by combatant ID and type.
 * Matches against character slug (case-insensitive).
 */
function findPlayerByCombatant(
  state: GameState,
  combatantId: string,
  combatantType: CombatantType,
): number {
  const id = combatantId.toLowerCase();

  for (let i = 0; i < state.config.players.length; i++) {
    const p = state.config.players[i];
    const charId = p.character.toLowerCase();

    // Match by character name
    if (charId === id) {
      // Verify type alignment
      if (combatantType === "pc" && p.type === "human") return i;
      if (combatantType === "ai_pc" && p.type === "ai") return i;
      // Also match pc to ai or ai_pc to human (flexible)
      return i;
    }
  }

  return -1;
}

/**
 * Check if it's an AI player's turn (either in combat or free play).
 */
export function isAITurn(state: GameState): boolean {
  if (state.combat.active) {
    const player = getCombatActivePlayer(state);
    return player?.isAI ?? false;
  }
  return getActivePlayer(state).isAI;
}

/**
 * Build player entries for TUI display.
 */
export function getPlayerEntries(state: GameState): { name: string; isAI: boolean }[] {
  return state.config.players.map((p) => ({
    name: p.character,
    isAI: p.type === "ai",
  }));
}
