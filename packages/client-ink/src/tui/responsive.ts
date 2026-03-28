import type { ViewportTier, ViewportDimensions } from "@machine-violet/shared/types/tui.js";

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

/** Extra rows added to the Player Pane at higher viewport tiers. */
export const PLAYER_PANE_EXTRA_ROWS = 4;

/** Which UI elements are visible at a given tier */
export interface VisibleElements {
  topFrame: boolean;
  sideFrames: boolean;
  activityLine: boolean;
  lowerFrame: boolean;
  modeline: boolean;
  playerSelector: boolean;
  activityGlyphInModeline: boolean; // when activity line is dropped
  playerPaneExtraRows: number; // extra rows for modeline + choice coexistence
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
        playerPaneExtraRows: PLAYER_PANE_EXTRA_ROWS,
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
        playerPaneExtraRows: 0,
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
  playerPaneExtraHeight = 0,
): number {
  void hideInputLine; // Player Pane is always visible; hideInputLine has no effect on row count
  let used = 0;

  // Player Pane is fixed-height (includes borders, modeline, and input line)
  // playerPaneExtraRows adds tier-based rows (modeline + choice coexistence)
  // playerPaneExtraHeight adds rows when e.g. a description region is shown
  used += PLAYER_PANE_HEIGHT + elements.playerPaneExtraRows + playerPaneExtraHeight;

  if (elements.topFrame) used += borderHeight;
  if (elements.lowerFrame) used += borderHeight;
  if (elements.activityLine) used += 1;
  if (elements.playerSelector && playerCount > 1) used += 1;

  return Math.max(1, totalRows - used);
}

/**
 * Compute the maximum number of choice rows visible in the Player Pane overlay.
 * @param elements — visible elements for the current tier.
 * @param modelineLineCount — number of lines the modeline occupies (0 when not shown alongside).
 * @param hasDescriptions — whether a description region is present.
 * @param descriptionRows — rows reserved for descriptions (typically DESCRIPTION_ROWS = 3).
 */
export function choiceRowBudget(
  elements: VisibleElements,
  modelineLineCount: number,
  hasDescriptions: boolean,
  descriptionRows: number,
): number {
  const extraHeight = hasDescriptions ? descriptionRows : 0;
  const contentHeight = PLAYER_PANE_HEIGHT + elements.playerPaneExtraRows + extraHeight - 2;
  // modeline shown alongside overlay only when extra rows exist
  const mlRows = elements.playerPaneExtraRows > 0 ? modelineLineCount : 0;
  // overhead: prompt (1) + help hint (1) + optional description region
  const overhead = 2 + (hasDescriptions ? descriptionRows : 0);
  return Math.max(1, contentHeight - mlRows - overhead);
}
