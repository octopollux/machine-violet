import type Anthropic from "@anthropic-ai/sdk";
import type { CampaignConfig } from "../types/config.js";

/**
 * Build the cached prefix (system prompt) for the DM agent.
 *
 * Three stability tiers with four cache breakpoints:
 *
 *   Tier 1 (campaign-stable): DM prompt, personality, game system, campaign setting, rules  [BP1]
 *   Tier 2 (session/scene-stable): session recap, campaign summary, scene precis, player read  [BP2]
 *   Tier 3 (volatile): active state, entity index, UI state
 *
 * BP1 on rules appendix (1h). BP2 on last emitted Tier 2 block (1h).
 * BP3 on tools (stamped in agent-session). BP4 on conversation (stamped in game-engine).
 */
export interface PrefixSections {
  dmPrompt: string;
  personality: string;
  rulesAppendix?: string;
  campaignSummary?: string;
  sessionRecap?: string;
  activeState?: string;
  scenePrecis?: string;
  playerRead?: string;
  entityIndex?: string;
  uiState?: string;
}

/**
 * Build the system prompt as an array of TextBlockParam.
 * Using array format allows the API to cache the stable prefix
 * and only pay full price for the changing parts.
 */
export function buildCachedPrefix(
  config: CampaignConfig,
  sections: PrefixSections,
): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];

  // ── Tier 1: Campaign-stable (never invalidated) ──

  // DM identity
  blocks.push({
    type: "text",
    text: sections.dmPrompt,
  });

  // DM personality fragment
  if (sections.personality) {
    blocks.push({
      type: "text",
      text: `\n\n## Your Personality\n${sections.personality}`,
    });
  }

  // Game system
  if (config.system) {
    blocks.push({
      type: "text",
      text: `\n\n## Game System\nYou are running: ${config.system}`,
    });
  }

  // Campaign setting (genre, mood, difficulty, premise)
  {
    const settingLines: string[] = [];
    if (config.genre) settingLines.push(`Genre: ${config.genre}`);
    if (config.mood) settingLines.push(`Mood: ${config.mood}`);
    if (config.difficulty) settingLines.push(`Difficulty: ${config.difficulty}`);
    if (config.premise) settingLines.push(`Premise: ${config.premise}`);
    if (settingLines.length > 0) {
      blocks.push({
        type: "text",
        text: `\n\n## Campaign Setting\n${settingLines.join("\n")}`,
      });
    }
  }

  // Rules appendix
  if (sections.rulesAppendix) {
    blocks.push({
      type: "text",
      text: `\n\n## Rules Reference\n${sections.rulesAppendix}`,
    });
  }

  // BP1 — stamp on last Tier 1 block (1h, covers all campaign-stable content)
  // Falls back to DM prompt/personality/setting when rulesAppendix is absent
  if (blocks.length > 0) {
    (blocks[blocks.length - 1] as unknown as Record<string, unknown>).cache_control =
      { type: "ephemeral", ttl: "1h" };
  }

  // ── Tier 2: Session/scene-stable (invalidated at scene transitions) ──

  const tier2Start = blocks.length;

  // Session recap
  if (sections.sessionRecap) {
    blocks.push({
      type: "text",
      text: `\n\n## Last Session\n${sections.sessionRecap}`,
    });
  }

  // Campaign summary
  if (sections.campaignSummary) {
    blocks.push({
      type: "text",
      text: `\n\n## Campaign Log\n${sections.campaignSummary}`,
    });
  }

  // Scene precis
  if (sections.scenePrecis) {
    blocks.push({
      type: "text",
      text: `\n\n## Scene So Far\n${sections.scenePrecis}`,
    });
  }

  // Player read (sentiment signals)
  if (sections.playerRead) {
    blocks.push({
      type: "text",
      text: `\n\n## Player Read\n${sections.playerRead}`,
    });
  }

  // BP2 — stamp on last emitted Tier 2 block (1h)
  if (blocks.length > tier2Start) {
    (blocks[blocks.length - 1] as unknown as Record<string, unknown>).cache_control =
      { type: "ephemeral", ttl: "1h" };
  }

  // ── Tier 3: Volatile (changes per turn, no cache_control) ──

  // Active state (changes during play)
  if (sections.activeState) {
    blocks.push({
      type: "text",
      text: `\n\n## Current State\n${sections.activeState}`,
    });
  }

  // Scene entity index (prevents duplicate entity creation)
  if (sections.entityIndex) {
    blocks.push({
      type: "text",
      text: `\n\n## Scene Entities\n${sections.entityIndex}`,
    });
  }

  // UI state (modelines, style — changes frequently)
  if (sections.uiState) {
    blocks.push({
      type: "text",
      text: `\n\n## UI State\n${sections.uiState}`,
    });
  }

  return blocks;
}

/**
 * Build a simple string system prompt (for non-DM agents like subagents).
 */
export function buildSimplePrefix(prompt: string): string {
  return prompt;
}
