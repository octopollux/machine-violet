/**
 * Compatibility bridge: extract a FrameStyleVariant from a ResolvedTheme.
 * Used by modals that still consume the old interface.
 * TODO: Remove when modals are migrated to themed frames (Phase 8).
 */

import type { FrameStyleVariant } from "../../types/tui.js";
import type { ResolvedTheme } from "./types.js";

/**
 * Convert a ResolvedTheme to a FrameStyleVariant.
 * Maps the theme's first-row border characters to the old single-char format.
 */
export function themeToVariant(theme: ResolvedTheme): FrameStyleVariant {
  const { asset, swatch, colorMap } = theme;

  // Extract the first character from each component's first row
  const h = asset.components.edge_top.rows[0]?.[0] ?? "─";
  const v = asset.components.edge_left.rows[0]?.[0] ?? "│";
  const ctl = asset.components.corner_tl.rows[0]?.[0] ?? "┌";
  const ctr = asset.components.corner_tr.rows[0]?.slice(-1) ?? "┐";
  const cbl = asset.components.corner_bl.rows[asset.height - 1]?.[0] ?? "└";
  const cbr = asset.components.corner_br.rows[asset.height - 1]?.slice(-1) ?? "┘";

  // Build a flourish template from the separator components
  const sl = asset.components.separator_left_top.rows[0]?.[0] ?? "┤";
  const sr = asset.components.separator_right_top.rows[0]?.slice(-1) ?? "├";
  const flourish = `${sl} %s ${sr}`;

  // Color from swatch
  const color = swatch[colorMap.border]?.hex;

  return {
    horizontal: h,
    vertical: v,
    corner_tl: ctl,
    corner_tr: ctr,
    corner_bl: cbl,
    corner_br: cbr,
    flourish,
    color,
  };
}
