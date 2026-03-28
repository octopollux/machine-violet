import type { UsageStats } from "./engine.js";

/** What the DM sends to resolve_turn */
export interface ActionDeclaration {
  actor: string;
  action: string;
  targets?: string[];
  conditions?: string;
}

/** Structured state change from resolution */
export interface StateDelta {
  type: "hp_change" | "condition_add" | "condition_remove" |
        "resource_spend" | "position_change";
  target: string;
  details: Record<string, unknown>;
}

/** What resolve() returns to the engine */
export interface ResolutionResult {
  narrative: string;
  deltas: StateDelta[];
  rolls: RollRecord[];
  usage: UsageStats;
}

export interface RollRecord {
  expression: string;
  reason: string;
  result: number;
  detail: string;
}

/** Compact per-turn summary for context accumulation */
export interface TurnSummary {
  round: number;
  actor: string;
  action: string;
  outcome: string;
}

/** State needed to construct/reconstruct a session (future persistence) */
export interface ResolveSessionState {
  mode: "combat" | "scene";
  turnHistory: TurnSummary[];
}
