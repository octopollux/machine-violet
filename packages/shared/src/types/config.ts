import type { CombatConfig } from "./combat.js";

/** Bump when CampaignConfig schema changes in a breaking way. */
export const CAMPAIGN_FORMAT_VERSION = 1;

export type ChoiceFrequency = "never" | "rarely" | "sometimes" | "often" | "always";

/** Ordered for UI sliders — low to high. */
export const CHOICE_FREQUENCY_LEVELS: readonly ChoiceFrequency[] = [
  "never",
  "rarely",
  "sometimes",
  "often",
  "always",
] as const;

export interface PlayerConfig {
  name: string;
  character: string;
  type: "human" | "ai";
  model?: "haiku" | "sonnet";
  personality?: string;
  color?: string;
  age_group?: "child" | "teenager" | "adult";
}

export interface DMPersonality {
  name: string;
  description?: string;
  prompt_fragment: string;
  /** Hidden detail block — rich tuning for the DM, not shown to the player during setup. */
  detail?: string;
}

export interface ContextConfig {
  retention_exchanges: number;
  max_conversation_tokens: number;
  /** @deprecated No longer used. Tool results are kept in full; caching makes stubbing unnecessary. */
  tool_result_stub_after?: number;
  /** Token budget for the rendered campaign log in the DM prefix. Default 15000. */
  campaign_log_budget?: number;
}

export interface RecoveryConfig {
  auto_commit_interval: number;
  max_commits: number;
  enable_git: boolean;
}

export interface ChoicesConfig {
  campaign_default: ChoiceFrequency;
  player_overrides: Record<string, ChoiceFrequency>;
}

export interface AppConfig {
  home_dir: string;
  api_key_path: string;
}

export interface CampaignConfig {
  version?: number;
  createdAt?: string;  // ISO 8601
  name: string;
  system?: string;
  genre?: string;
  mood?: string;
  difficulty?: string;
  premise?: string;
  /** Hidden campaign detail — DM-only instructions (variants, secrets, pacing notes). */
  campaign_detail?: string;
  /**
   * Handoff postcard written by the setup agent for the DM's first turn.
   * Free-form prose: player's words about their character, any freeform intent
   * captured in setup, setup-agent notes to the DM. Injected once into the
   * first-turn priming message; persists here for resume-from-disk after a
   * mid-first-turn crash. Never re-injected after the DM's opening narration
   * succeeds.
   */
  setup_handoff?: string;
  dm_personality: DMPersonality;
  players: PlayerConfig[];
  combat: CombatConfig;
  context: ContextConfig;
  recovery: RecoveryConfig;
  choices: ChoicesConfig;
  calendar_display_format?: string;
}
