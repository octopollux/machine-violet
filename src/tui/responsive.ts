import type { ViewportTier, ViewportDimensions } from "../types/tui.js";

/** Minimum supported terminal width. */
export const MIN_COLUMNS = 80;

/** Minimum supported terminal height. */
export const MIN_ROWS = 25;

/**
 * Determine the viewport tier based on terminal dimensions.
 * ≥80 cols and ≥40 rows → "full"; everything else → "standard".
 */
export function getViewportTier(dims: ViewportDimensions): ViewportTier {
  const { columns, rows } = dims;
  if (columns >= 80 && rows >= 40) return "full";
  return "standard";
}

/** Which UI elements are visible at a given tier */
export interface VisibleElements {
  topFrame: boolean;
  sideFrames: boolean;
  activityLine: boolean;
  lowerFrame: boolean;
  modeline: boolean;
  playerSelector: boolean;
  activityGlyphInModeline: boolean; // when activity line is dropped
}

/**
 * Determine which UI elements are visible for a viewport tier.
 * Full: everything visible.
 * Standard: top frame and activity line dropped; activity glyph moves to modeline.
 */
export function getVisibleElements(tier: ViewportTier): VisibleElements {
  switch (tier) {
    case "full":
      return {
        topFrame: true,
        sideFrames: true,
        activityLine: true,
        lowerFrame: true,
        modeline: true,
        playerSelector: true,
        activityGlyphInModeline: false,
      };
    case "standard":
      return {
        topFrame: false,
        sideFrames: true,
        activityLine: false,
        lowerFrame: true,
        modeline: true,
        playerSelector: true,
        activityGlyphInModeline: true,
      };
  }
}

/** Fixed height of the Player Pane including top/bottom borders. */
export const PLAYER_PANE_HEIGHT = 9;

/**
 * Calculate the number of rows available for the narrative area.
 * @param borderHeight — theme border height in rows (1 or 2, default 2).
 * @param playerCount — number of PCs; player selector row only counted when > 1.
 */
export function narrativeRows(
  totalRows: number,
  elements: VisibleElements,
  hideInputLine = false,
  borderHeight = 2,
  playerCount = 2,
): number {
  void hideInputLine; // Player Pane is always visible; hideInputLine has no effect on row count
  let used = 0;

  // Player Pane is fixed-height (includes borders, modeline, and input line)
  used += PLAYER_PANE_HEIGHT;

  if (elements.topFrame) used += borderHeight;
  if (elements.lowerFrame) used += borderHeight;
  if (elements.activityLine) used += 1;
  if (elements.playerSelector && playerCount > 1) used += 1;

  return Math.max(1, totalRows - used);
}
