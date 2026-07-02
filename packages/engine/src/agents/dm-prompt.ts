import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import { IMAGE_CADENCE_PER_100_DEFAULT, clampImageCadencePer100 } from "@machine-violet/shared/types/config.js";
import { buildCachedPrefix } from "../context/index.js";
import type { PrefixSections, CachedPrefixResult } from "../context/index.js";
import { getModel } from "../config/models.js";
import { loadPrompt } from "../prompts/load-prompt.js";
import { processIncludes, applyLayeredOverrides } from "../prompts/process-includes.js";

/**
 * Session state needed to build the DM's prefix.
 */
export interface DMSessionState {
  rulesAppendix?: string;
  /**
   * Verbatim PC character sheets concatenated into one block. Loaded once at
   * session start and intentionally NOT refreshed when sheets change in
   * session — the DM made the change via scribe/promote_character and sees
   * the result in the conversation, so a stale cached copy is acceptable and
   * keeps BP2 cache intact across the whole session.
   */
  pcSheets?: string;
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
 *
 * `modelId` is the runtime tier-resolved model serving the DM, used by
 * `<!--if:PREFIX-->` conditionals inside the prompt .md files. Callers should
 * pass the same model ID they'll send the request with (typically
 * `tierProviders.large.model`). When omitted, falls back to the static
 * `getModel("large")` — preserves legacy behavior for callers that don't have
 * tier routing wired up, but means conditionals won't reflect the actual
 * runtime provider.
 */
export function buildDMPrefix(
  config: CampaignConfig,
  sessionState: DMSessionState,
  modelId?: string,
): CachedPrefixResult {
  const model = modelId ?? getModel("large");

  // FIVE override slots, in cascading-override priority order (lowest →
  // highest): dm-identity → dm-directives → campaign_detail → personality
  // prompt_fragment → personality detail. (Conceptually three sources — main
  // DM = identity + directives, campaign seed = campaign_detail, DM personality
  // = fragment + detail — but applyLayeredOverrides treats them as five
  // distinct slots, and precedence is slot-by-slot.) The campaign_detail slot
  // itself holds the seed's assembled detail FOLLOWED BY any setup-agent-
  // appended detail, so a colliding <TAG> the agent appended beats the seed's,
  // which beats the base — by design (the setup agent may clobber seed data).
  //
  // Each slot's text may contain `<!--include:Tag.Variant-->` directives and
  // top-level `<TAG>...</TAG>` blocks. Includes are resolved per slot
  // (loadPrompt already does this for the file-based slots; the inline strings
  // go through processIncludes here). Then applyLayeredOverrides walks all five
  // slots in order — when the same tag appears in more than one, only the last
  // occurrence survives, so a personality's `<NPCS>` block trumps a seed's,
  // which in turn trumps the main DM's.
  const dmIdentity = loadPrompt("dm-identity", model);
  // dm-directives carries a {{imageCadence}} placeholder for the per-campaign
  // image cadence target. Interpolate here (loadPrompt has no var substitution)
  // before applyLayeredOverrides — the placeholder lives in free prose, not a
  // <TAG> block, so override collapsing is unaffected.
  const imageCadence = clampImageCadencePer100(
    config.image_cadence_per_100 ?? IMAGE_CADENCE_PER_100_DEFAULT,
  );
  const dmDirectives = loadPrompt("dm-directives", model).replace(
    /\{\{imageCadence\}\}/g,
    String(imageCadence),
  );
  const campaignDetail = processIncludes(config.campaign_detail ?? "");
  const personality = processIncludes(config.dm_personality.prompt_fragment ?? "");
  const personalityDetail = processIncludes(config.dm_personality.detail ?? "");

  const [
    oDmIdentity,
    oDmDirectives,
    oCampaignDetail,
    oPersonality,
    oPersonalityDetail,
  ] = applyLayeredOverrides([
    dmIdentity,
    dmDirectives,
    campaignDetail,
    personality,
    personalityDetail,
  ]);

  const sections: PrefixSections = {
    dmIdentity: oDmIdentity,
    dmDirectives: oDmDirectives,
    personality: oPersonality,
    personalityDetail: oPersonalityDetail || undefined,
    campaignDetail: oCampaignDetail || undefined,
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
  /** Display name of the active game system. Omitted entirely when absent. */
  activeSystem?: string;
  /** When the system is run DM-managed (silently), tag the system line so the
   * reminder to keep mechanics behind the fiction rides the same cadence. */
  mechanicsSilent?: boolean;
  /** Player exchanges since the DM last generated an image. Omitted when image
   * generation is off (cadence 0), so the line never shows in image-less games. */
  turnsSinceImage?: number;
  /** Target images per 100 exchanges — sets the interval the counter is judged
   * against. The `(!)` nudge appears once turnsSinceImage exceeds that interval
   * by more than 2. */
  imageCadencePer100?: number;
}): string {
  const lines: string[] = [];

  if (params.activeSystem) {
    lines.push(`System: ${params.activeSystem}${params.mechanicsSilent ? " · running silently" : ""}`);
  }

  if (params.turnHolder) {
    lines.push(`Turn: ${params.turnHolder}${params.combatRound ? ` (Round ${params.combatRound})` : ""}`);
  }

  // Turns-since-last-image feedback signal. The DM systematically under-fires
  // generate_image; surfacing the running count (with a `(!)` once it's more
  // than 2 turns past the target interval) gives it a concrete cue without a
  // heavier directive. Shown only when image gen is on (cadence > 0).
  if (params.turnsSinceImage != null && params.imageCadencePer100 && params.imageCadencePer100 > 0) {
    const interval = 100 / params.imageCadencePer100;
    const overdue = params.turnsSinceImage > interval + 2;
    lines.push(`Images: ${params.turnsSinceImage} turns since last${overdue ? " (!)" : ""}`);
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

