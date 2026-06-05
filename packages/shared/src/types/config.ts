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

/**
 * Intended scope of a campaign at build time. Drives DM pacing — opening
 * momentum, willingness to slow-burn, when to start steering toward a
 * climax. Set during setup and read by the DM prefix; the user can change
 * it later by editing config.json.
 */
export type CampaignScope = "one-shot" | "few-sessions" | "grand-campaign" | "open-ended";

/** Ordered short → long. */
export const CAMPAIGN_SCOPES: readonly CampaignScope[] = [
  "one-shot",
  "few-sessions",
  "grand-campaign",
  "open-ended",
] as const;

/** Human labels for UI and prompt rendering. */
export const CAMPAIGN_SCOPE_LABELS: Record<CampaignScope, string> = {
  "one-shot": "One-Shot",
  "few-sessions": "A Few Sessions",
  "grand-campaign": "Grand Campaign",
  "open-ended": "Open-Ended",
};

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
  /** Intended campaign scope, set at build time. Shapes DM pacing decisions. */
  campaign_scope?: CampaignScope;
  premise?: string;
  /**
   * Hidden campaign detail — DM-only instructions. When the campaign was built
   * from a seed with forks, this is the **assembled** result: the seed's
   * fork-invariant base prose plus the `detail` of each *selected* fork option,
   * flattened once at finalize. Unchosen branches are never present — the DM
   * sees a single, fully-resolved campaign variant.
   */
  campaign_detail?: string;
  /**
   * Which fork option was selected for each of the seed's forks, as
   * `forkId → optionId`. First-class hard record of how this campaign's
   * variant was resolved at setup — used by the rich importer to materialize
   * the selected branch's scoped content, and for reproducibility. Absent for
   * fully custom campaigns and seeds without forks.
   */
  fork_selections?: Record<string, string>;
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
  /**
   * Multiplier (in percent) applied to the narrative row count reported to
   * the DM in the per-turn `[length]` hint. Default 80 — the DM sees a
   * smaller page than the terminal actually has, which nudges it toward
   * tighter prose. Overlong-response tracking still uses the real row count.
   * Range 50–150 in 5% steps.
   */
  dm_turn_length_pct?: number;
  /**
   * Player preference for inline image generation in this campaign.
   * "on"/"off" reflect an explicit choice; "unset" or absent means the
   * setup agent hasn't asked yet (or the campaign predates the feature)
   * and the setup flow should drive the choice when the active provider
   * + model expose the capability. When the effective provider/model
   * lacks image generation, this field is silently ignored — the feature
   * is gated by capability AND preference, not preference alone.
   */
  image_generation?: "on" | "off" | "unset";
}

export const DM_TURN_LENGTH_PCT_DEFAULT = 80;
export const DM_TURN_LENGTH_PCT_MIN = 50;
export const DM_TURN_LENGTH_PCT_MAX = 150;
export const DM_TURN_LENGTH_PCT_STEP = 5;

/** Clamp a candidate pct to the supported range, rounded to the step. */
export function clampDmTurnLengthPct(value: number): number {
  const stepped = Math.round(value / DM_TURN_LENGTH_PCT_STEP) * DM_TURN_LENGTH_PCT_STEP;
  return Math.max(DM_TURN_LENGTH_PCT_MIN, Math.min(DM_TURN_LENGTH_PCT_MAX, stepped));
}
