import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import type { SystemBlock } from "../providers/types.js";

/**
 * Build the cached prefix (system prompt) for the DM agent.
 *
 * Three stability tiers with four cache breakpoints:
 *
 *   Tier 1 (campaign-stable): DM prompt, personality, game system, campaign setting, rules  [BP1]
 *   Tier 2 (session/scene-stable): session recap, campaign summary, scene precis, player read  [BP2]
 *   Tier 3 (volatile): active state, entity index, UI state — injected into conversation, NOT system
 *
 * BP1 on rules appendix (1h). BP2 on last emitted Tier 2 block (1h).
 * BP3 on tools (stamped in agent-session). BP4 on conversation (stamped in game-engine).
 *
 * Tier 3 is returned separately as `volatile` so the caller can inject it
 * into the conversation tail. This prevents Tier 3 changes from invalidating
 * the tools cache (BP3), which was causing ~2k+ tokens of cache writes per turn.
 */
export interface PrefixSections {
  dmPrompt: string;
  personality: string;
  personalityDetail?: string;
  campaignDetail?: string;
  rulesAppendix?: string;
  campaignSummary?: string;
  sessionRecap?: string;
  activeState?: string;
  scenePrecis?: string;
  playerRead?: string;
  dmNotes?: string;
  entityIndex?: string;
  uiState?: string;
  compendiumSummary?: string;
  contentBoundaries?: string;
  nameInspiration?: string;
}

export interface CachedPrefixResult {
  /** System prompt blocks (Tier 1 + Tier 2, cache-stable). */
  system: SystemBlock[];
  /** Volatile context string (Tier 3). Inject into conversation, not system prompt. */
  volatile: string;
}

/**
 * Build the system prompt as an array of SystemBlock.
 * Using array format allows the API to cache the stable prefix
 * and only pay full price for the changing parts.
 *
 * Returns both the cacheable system blocks and volatile context separately.
 */
export function buildCachedPrefix(
  config: CampaignConfig,
  sections: PrefixSections,
): CachedPrefixResult {
  const blocks: SystemBlock[] = [];

  // ── Tier 1: Campaign-stable (never invalidated) ──

  // DM identity
  blocks.push({ text: sections.dmPrompt });

  // DM personality fragment + hidden detail
  if (sections.personality) {
    let personalityText = `\n\n## Your Personality\n${sections.personality}`;
    if (sections.personalityDetail) {
      personalityText += `\n\n${sections.personalityDetail}`;
    }
    blocks.push({ text: personalityText });
  }

  // Game system
  if (config.system) {
    blocks.push({ text: `\n\n## Game System\nYou are running: ${config.system}` });
  }

  // Campaign setting (genre, mood, difficulty, premise)
  {
    const settingLines: string[] = [];
    if (config.genre) settingLines.push(`Genre: ${config.genre}`);
    if (config.mood) settingLines.push(`Mood: ${config.mood}`);
    if (config.difficulty) settingLines.push(`Difficulty: ${config.difficulty}`);
    if (config.premise) settingLines.push(`Premise: ${config.premise}`);
    if (settingLines.length > 0) {
      let settingText = `\n\n## Campaign Setting\n${settingLines.join("\n")}`;
      if (sections.campaignDetail) {
        settingText += `\n\n### Campaign Detail\n${sections.campaignDetail}`;
      }
      blocks.push({ text: settingText });
    } else if (sections.campaignDetail) {
      blocks.push({ text: `\n\n## Campaign Detail\n${sections.campaignDetail}` });
    }
  }

  // Rules appendix
  if (sections.rulesAppendix) {
    blocks.push({ text: `\n\n## Rules Reference\n${sections.rulesAppendix}` });
  }

  // BP1 — stamp on last Tier 1 block (1h, covers all campaign-stable content)
  if (blocks.length > 0) {
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cacheControl: { ttl: "1h" } };
  }

  // ── Tier 2: Session/scene-stable (invalidated at scene transitions) ──

  const tier2Start = blocks.length;

  // Session recap
  if (sections.sessionRecap) {
    blocks.push({ text: `\n\n## Last Session\n${sections.sessionRecap}` });
  }

  // Campaign summary
  if (sections.campaignSummary) {
    blocks.push({ text: `\n\n## Campaign Log\n${sections.campaignSummary}` });
  }

  // Scene precis
  if (sections.scenePrecis) {
    blocks.push({ text: `\n\n## Scene So Far\n${sections.scenePrecis}` });
  }

  // Player read (sentiment signals)
  if (sections.playerRead) {
    blocks.push({ text: `\n\n## Player Read\n${sections.playerRead}` });
  }

  // DM notes (campaign-scope scratchpad)
  if (sections.dmNotes) {
    blocks.push({ text: `\n\n## DM Notes\n${sections.dmNotes}` });
  }

  // Player knowledge (compendium summary)
  if (sections.compendiumSummary) {
    blocks.push({ text: `\n\n## Player Knowledge\nThe player currently knows about:\n${sections.compendiumSummary}` });
  }

  // Name inspiration — multicultural sample to perturb naming priors.
  // Refreshes per session; rides Tier 2 cache.
  if (sections.nameInspiration) {
    blocks.push({ text: `\n\n## Name Inspiration\n${sections.nameInspiration}` });
  }

  // BP2 — stamp on last emitted Tier 2 block (1h)
  if (blocks.length > tier2Start) {
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cacheControl: { ttl: "1h" } };
  }

  // ── Tier 3: Volatile — returned separately for conversation injection ──

  const volatileParts: string[] = [];

  if (sections.activeState) {
    volatileParts.push(`## Current State\n${sections.activeState}`);
  }

  if (sections.entityIndex) {
    volatileParts.push(`## Entity Registry\n${sections.entityIndex}`);
  }

  if (sections.uiState) {
    volatileParts.push(`## UI State\n${sections.uiState}`);
  }

  if (sections.contentBoundaries) {
    volatileParts.push(`## Content Boundaries\nHonor these absolutely — no exceptions, no references to them in narration.\n${sections.contentBoundaries}`);
  }

  return { system: blocks, volatile: volatileParts.join("\n\n") };
}

/**
 * Build a simple string system prompt (for non-DM agents like subagents).
 */
export function buildSimplePrefix(prompt: string): string {
  return prompt;
}
