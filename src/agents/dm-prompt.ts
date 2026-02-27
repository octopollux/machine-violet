import type { CampaignConfig } from "../types/config.js";
import { buildCachedPrefix } from "../context/index.js";
import type { PrefixSections } from "../context/index.js";
import type Anthropic from "@anthropic-ai/sdk";
import { loadPrompt } from "../prompts/load-prompt.js";

/**
 * The DM identity prompt. Kept under ~800 tokens.
 * This is the stable core — paid at cached rate on every turn.
 */
const DM_PROMPT = loadPrompt("dm-identity");

/**
 * Session state needed to build the DM's prefix.
 */
export interface DMSessionState {
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
 * Build the full DM system prompt as a cached prefix.
 * Returns TextBlockParam[] for the Claude API system field.
 */
export function buildDMPrefix(
  config: CampaignConfig,
  sessionState: DMSessionState,
): Anthropic.TextBlockParam[] {
  const sections: PrefixSections = {
    dmPrompt: DM_PROMPT,
    personality: config.dm_personality.prompt_fragment,
    ...sessionState,
  };

  return buildCachedPrefix(config, sections);
}

/**
 * Build the active state section from current game state.
 * This changes during play — location, PC summaries, pending alarms.
 */
export function buildActiveState(params: {
  location?: string;
  pcSummaries: string[];
  pendingAlarms: string[];
  turnHolder?: string;
  combatRound?: number;
}): string {
  const lines: string[] = [];

  if (params.location) {
    lines.push(`Location: ${params.location}`);
  }

  if (params.pcSummaries.length > 0) {
    lines.push("PCs:");
    for (const pc of params.pcSummaries) {
      lines.push(`  ${pc}`);
    }
  }

  if (params.turnHolder) {
    lines.push(`Turn: ${params.turnHolder}${params.combatRound ? ` (Round ${params.combatRound})` : ""}`);
  }

  if (params.pendingAlarms.length > 0) {
    lines.push("Pending alarms:");
    for (const alarm of params.pendingAlarms) {
      lines.push(`  ${alarm}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the UI state section for the DM's prefix.
 * Shows current modelines and style info so the DM can maintain consistency.
 */
export function buildUIState(params: {
  modelines: Record<string, string>;
  styleName: string;
  variant: string;
}): string | undefined {
  const lines: string[] = [];
  const entries = Object.entries(params.modelines);
  if (entries.length > 0) {
    lines.push("Modelines (as last set by you):");
    for (const [char, text] of entries) {
      lines.push(`  ${char}: ${text}`);
    }
  }
  lines.push(`UI: style=${params.styleName}, variant=${params.variant}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Exported for testing */
export { DM_PROMPT };
