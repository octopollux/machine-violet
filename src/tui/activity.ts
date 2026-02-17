import type { ActivityIndicator } from "../types/tui.js";

/** Map of engine states to their display indicators */
export const ACTIVITY_MAP: Record<string, ActivityIndicator> = {
  resolve_action: { label: "Resolving...", glyph: "⚔" },
  roll_dice: { label: "Rolling...", glyph: "⚄" },
  rule_lookup: { label: "Checking rules...", glyph: "📖" },
  scene_transition: { label: "Scene transition...", glyph: "⟳" },
  dm_thinking: { label: "The DM is thinking...", glyph: "◆" },
};

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

/** Get the activity indicator for an engine state, or undefined if idle */
export function getActivity(
  state: string | null,
): ActivityIndicator | undefined {
  if (!state) return undefined;
  // Check for retry state
  const retry = parseRetryState(state);
  if (retry) {
    return {
      label: `The DM is busy (${retry.status}) (${retry.delaySec}s)`,
      glyph: "⏳",
    };
  }
  return ACTIVITY_MAP[state];
}
