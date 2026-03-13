import type { ActivityIndicator } from "../types/tui.js";

/** Map of engine states to their display indicators */
export const ACTIVITY_MAP: Record<string, ActivityIndicator> = {
  resolve_action: { label: "Resolving...", glyph: "⚔" },
  roll_dice: { label: "Rolling...", glyph: "⚄" },
  rule_lookup: { label: "Checking rules...", glyph: "📖" },
  scene_transition: { label: "Scene transition...", glyph: "⟳" },
  dm_thinking: { label: "The DM is thinking...", glyph: "◆" },
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
  view_area:          { glyph: "◈", color: "blue" },
  distance:           { glyph: "◈", color: "blue" },
  path_between:       { glyph: "◈", color: "blue" },
  line_of_sight:      { glyph: "◈", color: "blue" },
  tiles_in_range:     { glyph: "◈", color: "blue" },
  find_nearest:       { glyph: "◈", color: "blue" },
  place_entity:       { glyph: "◈", color: "blue" },
  move_entity:        { glyph: "◈", color: "blue" },
  remove_entity:      { glyph: "◈", color: "blue" },
  set_terrain:        { glyph: "◈", color: "blue" },
  annotate:           { glyph: "◈", color: "blue" },
  define_region:      { glyph: "◈", color: "blue" },
  create_map:         { glyph: "◈", color: "blue" },
  import_entities:    { glyph: "◈", color: "blue" },
  // Clocks / time
  set_alarm:          { glyph: "⏲" },
  clear_alarm:        { glyph: "⏲" },
  advance_calendar:   { glyph: "⏲" },
  next_round:         { glyph: "⏲" },
  check_clocks:       { glyph: "⏲" },
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
  present_roll:       { glyph: "◆", color: "magenta" },
  show_character_sheet: { glyph: "◆", color: "magenta" },
  enter_ooc:          { glyph: "◆", color: "magenta" },
  switch_player:      { glyph: "◆", color: "magenta" },
  // Scene / session lifecycle
  scene_transition:   { glyph: "⟳", color: "yellow" },
  session_end:        { glyph: "⟳", color: "yellow" },
  context_refresh:    { glyph: "⟳", color: "yellow" },
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
  return ACTIVITY_MAP[state];
}
