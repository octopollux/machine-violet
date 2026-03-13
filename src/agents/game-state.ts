import type { MapData } from "../types/maps.js";
import type { ClocksState } from "../types/clocks.js";
import type { CombatState, CombatConfig } from "../types/combat.js";
import type { DecksState } from "../types/cards.js";
import type { CampaignConfig } from "../types/config.js";

/**
 * All mutable game state, passed to tool handlers.
 * This is the single source of truth during a session.
 */
export interface GameState {
  maps: Record<string, MapData>;
  clocks: ClocksState;
  combat: CombatState;
  combatConfig: CombatConfig;
  decks: DecksState;
  config: CampaignConfig;
  campaignRoot: string;
  /** Application home directory (e.g. ~/.machine-violet) for system content paths. */
  homeDir: string;
  /** Index into config.players — tracks whose turn it is */
  activePlayerIndex: number;
  /** Per-character resource display keys */
  displayResources: Record<string, string[]>;
  /** Per-character resource values: character → key → value */
  resourceValues: Record<string, Record<string, string>>;
}
