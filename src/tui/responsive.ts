import type { ViewportTier, ViewportDimensions } from "../types/tui.js";

/**
 * Determine the viewport tier based on terminal dimensions.
 */
export function getViewportTier(dims: ViewportDimensions): ViewportTier {
  const { columns, rows } = dims;

  if (columns >= 80 && rows >= 40) return "full";
  if (columns >= 40 && rows >= 40) return "narrow";
  if (columns >= 80 && rows >= 24) return "short";
  if (columns >= 40 && rows >= 24) return "compact";
  return "minimal";
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
  turnInfoInModeline: boolean;      // when lower frame is dropped
  playerInPrompt: boolean;          // when player selector is dropped
}

/**
 * Determine which UI elements are visible for a viewport tier.
 * Drop order: side frames → top frame → activity line → lower frame → modeline → player selector
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
        turnInfoInModeline: false,
        playerInPrompt: false,
      };
    case "narrow":
      return {
        topFrame: true,
        sideFrames: false,
        activityLine: true,
        lowerFrame: true,
        modeline: true,
        playerSelector: true,
        activityGlyphInModeline: false,
        turnInfoInModeline: false,
        playerInPrompt: false,
      };
    case "short":
      return {
        topFrame: false,
        sideFrames: true,
        activityLine: false,
        lowerFrame: true,
        modeline: true,
        playerSelector: true,
        activityGlyphInModeline: true,
        turnInfoInModeline: false,
        playerInPrompt: false,
      };
    case "compact":
      return {
        topFrame: false,
        sideFrames: false,
        activityLine: false,
        lowerFrame: true,
        modeline: true,
        playerSelector: true,
        activityGlyphInModeline: true,
        turnInfoInModeline: false,
        playerInPrompt: false,
      };
    case "minimal":
      return {
        topFrame: false,
        sideFrames: false,
        activityLine: false,
        lowerFrame: false,
        modeline: false,
        playerSelector: false,
        activityGlyphInModeline: false,
        turnInfoInModeline: false,
        playerInPrompt: true,
      };
  }
}

/**
 * Whether to use ASCII fallback for frame rendering.
 * Below 40 columns, Unicode box-drawing may not render well.
 */
export function useAsciiFallback(columns: number): boolean {
  return columns < 40;
}

/**
 * Calculate the number of rows available for the narrative area.
 * @param modelineHeight — actual line count of the wrapped modeline (default 1).
 */
export function narrativeRows(
  totalRows: number,
  elements: VisibleElements,
  hideInputLine = false,
  modelineHeight = 1,
): number {
  let used = 0;

  // Input line: present unless explicitly hidden (1 row)
  if (!hideInputLine) used += 1;

  if (elements.topFrame) used += 2;    // border + resource line
  if (elements.lowerFrame) used += 1;  // separator with turn indicator
  if (elements.activityLine) used += 1;
  if (elements.modeline) used += modelineHeight;
  if (elements.playerSelector) used += 1;

  return Math.max(1, totalRows - used);
}
