import type { ActivityIndicator } from "@machine-violet/shared/types/tui.js";

/** A label tier that becomes active once `atSec` of elapsed time has passed. */
export interface LabelTier {
  atSec: number;
  label: string;
}

/** Internal indicator with optional escalation tiers. */
type IndicatorWithTiers = ActivityIndicator & { tiers?: LabelTier[] };

/** Map of engine states to their display indicators.
 *  `tiers` (optional) escalate the label after the listed elapsed seconds —
 *  used for known-slow states (campaign start, first DM turn) so a long
 *  silent wait reads as progress rather than a hung UI. */
export const ACTIVITY_MAP: Record<string, IndicatorWithTiers> = {
  roll_dice: { label: "Rolling...", glyph: "⚄" },
  rule_lookup: { label: "Checking rules...", glyph: "📖" },
  scene_transition: { label: "Scene transition...", glyph: "⟳" },
  dm_thinking: {
    label: "The DM is thinking...",
    glyph: "◆",
    tiers: [
      { atSec: 30, label: "The DM is composing the scene..." },
      { atSec: 75, label: "The DM is still working..." },
    ],
  },
  // Engine emits this for the duration of any in-flight tool call.
  // Most tools finish in milliseconds, but subagent-backed tools (style_scene
  // → theme-styler, scribe, etc.) routinely run 20-60s. Without an entry
  // here the activity line goes blank — taking the accumulated tool glyphs
  // with it — and the user sees what looks like a player-turn pause.
  tool_running: {
    label: "The DM is working...",
    glyph: "◆",
    tiers: [
      { atSec: 15, label: "Working on the world..." },
      { atSec: 45, label: "Still working..." },
    ],
  },
  // Spans the gap between setup→game handoff and the first DM event.
  // The first DM turn after setup is a long single LLM call (theme + modelines
  // + resources + opening narration) and routinely takes 60-90s of silence.
  starting_session: {
    label: "Preparing your campaign...",
    glyph: "◆",
    tiers: [
      { atSec: 15, label: "Setting the scene..." },
      { atSec: 45, label: "Almost there..." },
    ],
  },
};

/** A glyph with an optional color (for non-emoji unicode characters). */
export interface ToolGlyph {
  glyph: string;
  color?: string;
}

/** Map tool names to glyphs that accumulate on the activity line during a DM turn. */
const TOOL_GLYPH_MAP: Record<string, ToolGlyph> = {
  // Dice
  roll_dice:          { glyph: "⚄", color: "yellow" },
  // Cards
  deck:               { glyph: "♠", color: "cyan" },
  // Map / spatial
  map:                { glyph: "◈", color: "blue" },
  map_entity:         { glyph: "◈", color: "blue" },
  map_query:          { glyph: "◈", color: "blue" },
  // Clocks / time
  alarm:              { glyph: "⏲" },
  time:               { glyph: "⏲" },
  // Combat
  start_combat:       { glyph: "⚔", color: "red" },
  end_combat:         { glyph: "⚔", color: "red" },
  advance_turn:       { glyph: "⚔", color: "red" },
  modify_initiative:  { glyph: "⚔", color: "red" },
  // Entity / worldbuilding
  scribe:             { glyph: "✎", color: "green" },
  dm_notes:           { glyph: "✎", color: "green" },
  // TUI / presentation
  update_modeline:    { glyph: "◆", color: "magenta" },
  style_scene:        { glyph: "◆", color: "magenta" },
  set_display_resources: { glyph: "◆", color: "magenta" },
  present_choices:    { glyph: "◆", color: "magenta" },
  show_character_sheet: { glyph: "◆", color: "magenta" },
  enter_ooc:          { glyph: "◆", color: "magenta" },
  switch_player:      { glyph: "◆", color: "magenta" },
  // Scene / session lifecycle
  scene_transition:   { glyph: "⟳", color: "yellow" },
  session_end:        { glyph: "⟳", color: "yellow" },
  rollback:           { glyph: "⟳", color: "yellow" },
};

/** Look up the glyph for a tool name. Returns undefined for unknown tools. */
export function getToolGlyph(toolName: string): ToolGlyph | undefined {
  return TOOL_GLYPH_MAP[toolName];
}

/** Parsed retry info from an engine state string */
export interface RetryInfo {
  status: number;
  delaySec: number;
}

/**
 * Parse a retry engine state string like "retry:429:10".
 * Returns null if not a retry state.
 */
export function parseRetryState(state: string): RetryInfo | null {
  const match = state.match(/^retry:(\d+):(\d+)$/);
  if (!match) return null;
  return { status: Number(match[1]), delaySec: Number(match[2]) };
}

/** Human-friendly label for a retry HTTP status (or 0 for network errors). */
export function retryLabel(status: number): string {
  if (status === 0) return "Connection lost";
  if (status === 429) return "Rate limited";
  if (status === 529) return "API overloaded";
  return `API error (${status})`;
}

/** Get the activity indicator for an engine state, or undefined if idle.
 *  Retry states (e.g. "retry:429:10") are handled by ApiErrorModal
 *  and intentionally return undefined here. */
export function getActivity(
  state: string | null,
): ActivityIndicator | undefined {
  if (!state) return undefined;
  const ind = ACTIVITY_MAP[state];
  if (!ind) return undefined;
  return { label: ind.label, glyph: ind.glyph };
}

/** Resolve the label for an engine state at a given elapsed time.
 *  Walks the indicator's tier list (if any) and returns the latest tier
 *  whose threshold has been reached, falling back to the base label. */
export function getActivityLabel(
  state: string | null,
  elapsedSec: number,
): string | undefined {
  if (!state) return undefined;
  const ind = ACTIVITY_MAP[state];
  if (!ind) return undefined;
  let label = ind.label;
  if (ind.tiers) {
    for (const t of ind.tiers) {
      if (elapsedSec >= t.atSec) label = t.label;
    }
  }
  return label;
}
