import type { CampaignConfig, PlayerConfig } from "@machine-violet/shared/types/config.js";
import { CAMPAIGN_FORMAT_VERSION } from "@machine-violet/shared/types/config.js";
import type { DMPersonality } from "@machine-violet/shared/types/config.js";
import { createDefaultConfig as defaultCombatConfig } from "../tools/combat/index.js";

// --- Types ---

export interface SetupChoice {
  label: string;
  description?: string;
}

export interface SetupResult {
  genre: string;
  system: string | null;
  campaignName: string;
  campaignPremise: string;
  /** Hidden campaign detail — DM-only instructions from the seed's detail block. */
  campaignDetail: string | null;
  mood: string;
  difficulty: string;
  personality: DMPersonality;
  playerName: string;
  characterName: string;
  characterDescription: string;
  characterDetails: string | null;
  themeColor: string;
  ageGroup?: "child" | "teenager" | "adult";
  /** Freeform content preferences captured during setup (one per line). */
  contentPreferences?: string;
  /**
   * Handoff postcard for the DM's first turn. Written by the setup agent
   * as free-form prose summarising what the player actually said (character
   * in their own words, freeform world/tone notes, anything else useful),
   * plus anything the setup agent wants to pass along. Injected once into
   * the DM's first-turn priming message; persisted in CampaignConfig so it
   * survives a mid-first-turn crash and restart.
   */
  handoffNote?: string;
}

/**
 * Build a CampaignConfig from setup results.
 */
export function buildCampaignConfig(result: SetupResult): CampaignConfig {
  const player: PlayerConfig = {
    name: result.playerName,
    character: result.characterName,
    type: "human",
    color: result.themeColor,
    age_group: result.ageGroup,
  };

  return {
    version: CAMPAIGN_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    name: result.campaignName,
    system: result.system ?? undefined,
    genre: result.genre,
    mood: result.mood,
    difficulty: result.difficulty,
    premise: result.campaignPremise,
    campaign_detail: result.campaignDetail ?? undefined,
    setup_handoff: result.handoffNote ?? undefined,
    dm_personality: result.personality,
    players: [player],
    combat: defaultCombatConfig(),
    context: {
      retention_exchanges: 100,
      max_conversation_tokens: 0,
      tool_result_stub_after: 5,
    },
    recovery: {
      // Commit every exchange. Git commits on a fresh campaign are tiny and
      // cheap; the downside of bundling exchanges is that a crash drops work
      // back to the last commit, and losing even a single DM turn is painful
      // because DM turns frequently produce rich content (full dm-notes, NPCs,
      // scene prep). One commit per exchange is the crash-safety floor.
      auto_commit_interval: 1,
      max_commits: 500,
      enable_git: true,
    },
    choices: {
      campaign_default: "never",
      player_overrides: {},
    },
  };
}

// --- Helpers ---

/**
 * Generate a theme color for a character, suitable for dark TUI backgrounds.
 * Uses a simple hash of the name to pick a hue, with guaranteed minimum brightness.
 */
export function generateThemeColor(name: string): string {
  // Simple hash
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }

  // Convert to HSL with high saturation and lightness for dark backgrounds
  const hue = Math.abs(hash) % 360;
  const saturation = 60 + (Math.abs(hash >> 8) % 30);   // 60-90%
  const lightness = 55 + (Math.abs(hash >> 16) % 20);    // 55-75%

  // Convert HSL to hex
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lN - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
