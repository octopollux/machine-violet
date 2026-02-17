import type { ActivityIndicator } from "../types/tui.js";

/** Map of engine states to their display indicators */
export const ACTIVITY_MAP: Record<string, ActivityIndicator> = {
  resolve_action: { label: "Resolving...", glyph: "⚔" },
  roll_dice: { label: "Rolling...", glyph: "⚄" },
  rule_lookup: { label: "Checking rules...", glyph: "📖" },
  scene_transition: { label: "Scene transition...", glyph: "⟳" },
  dm_thinking: { label: "The DM is thinking...", glyph: "◆" },
};

/** Get the activity indicator for an engine state, or undefined if idle */
export function getActivity(
  state: string | null,
): ActivityIndicator | undefined {
  if (!state) return undefined;
  return ACTIVITY_MAP[state];
}
