/**
 * Title-wrapping helpers for the conversation pane top frame.
 *
 * The title slot in `composeTopFrame` lives between the corners and
 * separators on row 0. When the title is longer than the slot can fit,
 * the composer silently drops the entire row (corners and title alike) —
 * see composer.ts. To keep all four resources visible without losing the
 * frame, we split the title at ` | ` boundaries and let the head chunk
 * sit in the title slot while remaining chunks wrap onto extra rows the
 * layout inserts above the narrative area.
 */
import type { ThemeAsset } from "./themes/types.js";
import { stringWidth } from "./frames/index.js";

/**
 * Maximum title length (in display columns) that fits in the top frame's
 * title slot at row 0: total width minus the row's fixed parts (two
 * corners + two separators) and the two padding spaces around the
 * centerText. Falls back to 0 if the slot can't accommodate even an
 * empty title (extremely narrow terminal).
 *
 * Uses `stringWidth` rather than `.length` so wide Unicode glyphs in a
 * theme's corner / separator (or in a future title) don't undercount.
 */
export function topFrameTitleBudget(asset: ThemeAsset, width: number): number {
  const { corner_tl, corner_tr, separator_left_top, separator_right_top } = asset.components;
  // Row 0 is what holds the title; the +2 accounts for ` ${title} ` padding.
  const fixedWidth =
    stringWidth(corner_tl.rows[0] ?? "") +
    stringWidth(corner_tr.rows[0] ?? "") +
    stringWidth(separator_left_top.rows[0] ?? "") +
    stringWidth(separator_right_top.rows[0] ?? "");
  return Math.max(0, width - fixedWidth - 2);
}

/**
 * Greedily pack ` | `-separated segments into lines of at most `maxWidth`
 * display columns. The separator is consumed at the break, mirroring
 * splitModeline's behavior. A segment that alone exceeds maxWidth occupies
 * its own line — truncation isn't this function's job; the renderer does
 * that.
 */
export function splitTitle(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || stringWidth(text) <= maxWidth) return [text];

  const segments = text.split(" | ");
  const lines: string[] = [];
  let current = segments[0];

  for (let i = 1; i < segments.length; i++) {
    const candidate = current + " | " + segments[i];
    if (stringWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = segments[i];
    }
  }
  lines.push(current);
  return lines;
}
