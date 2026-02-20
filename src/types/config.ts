import type { CombatConfig } from "./combat.js";

export type ChoiceFrequency = "none" | "rarely" | "often" | "always";

export interface PlayerConfig {
  name: string;
  character: string;
  type: "human" | "ai";
  model?: "haiku" | "sonnet";
  personality?: string;
  color?: string;
}

export interface DMPersonality {
  name: string;
  prompt_fragment: string;
}

export interface ContextConfig {
  retention_exchanges: number;
  max_conversation_tokens: number;
  tool_result_stub_after: number;
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
  name: string;
  system?: string;
  genre?: string;
  mood?: string;
  difficulty?: string;
  premise?: string;
  dm_personality: DMPersonality;
  players: PlayerConfig[];
  combat: CombatConfig;
  context: ContextConfig;
  recovery: RecoveryConfig;
  choices: ChoicesConfig;
  calendar_display_format?: string;
}
