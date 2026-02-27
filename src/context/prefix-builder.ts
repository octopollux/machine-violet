import type Anthropic from "@anthropic-ai/sdk";
import type { CampaignConfig } from "../types/config.js";

/**
 * Build the cached prefix (system prompt) for the DM agent.
 * Layout per context-management.md:
 *   1. DM identity prompt
 *   2. DM personality fragment
 *   3. Rules appendix (distilled rule cards)
 *   4. Campaign summary (log with wikilinks)
 *   5. Session recap
 *   6. Active state (location, PC summaries, alarms)
 *   7. Current scene summary (running precis)
 */
export interface PrefixSections {
  dmPrompt: string;
  personality: string;
  rulesAppendix?: string;
  campaignSummary?: string;
  sessionRecap?: string;
  activeState?: string;
  scenePrecis?: string;
  scenePacing?: string;
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

  // DM identity (stable — good cache candidate)
  blocks.push({
    type: "text",
    text: sections.dmPrompt,
    cache_control: { type: "ephemeral", ttl: "1h" },
  } as Anthropic.TextBlockParam);

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

  // Rules appendix (cached — stable within a session)
  if (sections.rulesAppendix) {
    blocks.push({
      type: "text",
      text: `\n\n## Rules Reference\n${sections.rulesAppendix}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    } as Anthropic.TextBlockParam);
  }

  // Campaign summary (cached — stable within a scene)
  if (sections.campaignSummary) {
    blocks.push({
      type: "text",
      text: `\n\n## Campaign Log\n${sections.campaignSummary}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    } as Anthropic.TextBlockParam);
  }

  // Session recap (changes once at session start)
  if (sections.sessionRecap) {
    blocks.push({
      type: "text",
      text: `\n\n## Last Session\n${sections.sessionRecap}`,
    });
  }

  // Active state (changes during play)
  if (sections.activeState) {
    blocks.push({
      type: "text",
      text: `\n\n## Current State\n${sections.activeState}`,
    });
  }

  // Scene precis (changes as exchanges are pruned)
  if (sections.scenePrecis) {
    blocks.push({
      type: "text",
      text: `\n\n## Scene So Far\n${sections.scenePrecis}`,
    });
  }

  // Scene pacing (exchange count, thread metrics — helps DM gauge scene ripeness)
  if (sections.scenePacing) {
    blocks.push({
      type: "text",
      text: `\n\n## Scene Pacing\n${sections.scenePacing}`,
    });
  }

  // Player read (sentiment signals from dropped exchanges)
  if (sections.playerRead) {
    blocks.push({
      type: "text",
      text: `\n\n## Player Read\n${sections.playerRead}`,
    });
  }

  // Scene entity index (prevents duplicate entity creation)
  if (sections.entityIndex) {
    blocks.push({
      type: "text",
      text: `\n\n## Scene Entities\n${sections.entityIndex}`,
    });
  }

  // UI state (modelines, style — changes frequently, no cache_control)
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
