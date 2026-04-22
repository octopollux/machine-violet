import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import { buildCachedPrefix } from "../context/index.js";
import type { PrefixSections, CachedPrefixResult } from "../context/index.js";
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
  /**
   * Hard numeric state (turn holder, combat round, resource values).
   * Not part of the volatile context prefix — the HardStatsInjection pulls
   * this out so it can be emitted on a cadence + on-change, rather than
   * re-sent every turn. See docs on HardStatsInjection for why.
   */
  hardStats?: string;
  scenePrecis?: string;
  playerRead?: string;
  dmNotes?: string;
  entityIndex?: string;
  uiState?: string;
  compendiumSummary?: string;
  contentBoundaries?: string;
  /** Multicultural name pool sampled at session start to perturb naming priors. */
  nameInspiration?: string;
}

/**
 * Build the full DM system prompt as a cached prefix.
 * Returns system blocks (Tier 1+2) and volatile context (Tier 3) separately.
 * Volatile context should be injected into the conversation, not the system prompt,
 * to avoid invalidating the tools cache (BP3) on every turn.
 */
export function buildDMPrefix(
  config: CampaignConfig,
  sessionState: DMSessionState,
): CachedPrefixResult {
  const sections: PrefixSections = {
    dmPrompt: DM_PROMPT,
    personality: config.dm_personality.prompt_fragment,
    personalityDetail: config.dm_personality.detail,
    campaignDetail: config.campaign_detail,
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
  activeObjectives?: string[];
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

  if (params.pendingAlarms.length > 0) {
    lines.push("Pending alarms:");
    for (const alarm of params.pendingAlarms) {
      lines.push(`  ${alarm}`);
    }
  }

  if (params.activeObjectives && params.activeObjectives.length > 0) {
    lines.push("Objectives:");
    for (const obj of params.activeObjectives) {
      lines.push(`  ${obj}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the hard-numeric stats block: turn holder, combat round, resource
 * values. These are the facts the DM most often loses track of (HP, initiative),
 * but they're also the parts of the volatile context most likely to be
 * structurally stable turn-to-turn. Emitted on a cadence (every-other-turn)
 * via HardStatsInjection rather than on every turn, plus immediately whenever
 * the rendered string changes — so we keep the DM accurate without paying
 * the full uncached cost of the volatile block every turn.
 *
 * Returns "" when there's nothing to show, so callers can cheaply skip.
 */
export function buildHardStats(params: {
  turnHolder?: string;
  combatRound?: number;
  resourceValues?: Record<string, Record<string, string>>;
}): string {
  const lines: string[] = [];

  if (params.turnHolder) {
    lines.push(`Turn: ${params.turnHolder}${params.combatRound ? ` (Round ${params.combatRound})` : ""}`);
  }

  if (params.resourceValues) {
    const resourceLines: string[] = [];
    for (const [char, kvs] of Object.entries(params.resourceValues)) {
      const pairs = Object.entries(kvs).map(([k, v]) => `${k}=${v}`);
      if (pairs.length > 0) {
        resourceLines.push(`  ${char}: ${pairs.join(", ")}`);
      }
    }
    if (resourceLines.length > 0) {
      lines.push("Resources:");
      lines.push(...resourceLines);
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
