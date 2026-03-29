export type CombatantType = "pc" | "npc" | "ai_pc";

export interface Combatant {
  id: string;
  type: CombatantType;
  modifier?: number;    // initiative modifier (e.g., DEX mod for d20_dex)
  initiative?: number;  // pre-set initiative (for custom/fiction_first)
}

export interface InitiativeEntry {
  id: string;
  initiative: number;
  type: CombatantType;
}

export type InitiativeMethod =
  | "d20_dex"
  | "card_draw"
  | "fiction_first"
  | "custom";

export type RoundStructure = "individual" | "side" | "popcorn";

export interface CombatConfig {
  initiative_method: InitiativeMethod;
  initiative_deck?: string;
  round_structure: RoundStructure;
  surprise_rules: boolean;
}

export interface CombatState {
  active: boolean;
  order: InitiativeEntry[];
  round: number;
  currentTurn: number; // index into order
}

export interface StartCombatInput {
  combatants: Combatant[];
}

export interface StartCombatOutput {
  order: InitiativeEntry[];
  round: number;
}

export type ModifyAction = "add" | "remove" | "move" | "delay";

export interface ModifyInitiativeInput {
  action: ModifyAction;
  combatant: string;
  position?: string; // "after:G1" or initiative value
}

export interface EndCombatOutput {
  rounds: number;
  combat_clock_reset: boolean;
}

export interface AdvanceTurnOutput {
  current: InitiativeEntry;
  newRound: boolean;
  round: number;
}
