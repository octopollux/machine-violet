/**
 * Composes the terminal escape string that blits an image band at an absolute
 * position, with targeted erase of rows a previous paint vacated.
 *
 * Shared by all protocols: this runs spliced just before ESU, after Ink's
 * frame content, so the cursor is parked at Ink's resting position. Callers
 * pass that resting position as `cursorRow` (the 0-based app row the cursor
 * sits ON): for a fullscreen frame Ink writes no trailing newline, so the
 * cursor rests on the LAST app row (`appHeight - 1`); for a non-fullscreen
 * frame the trailing newline parks it one row below the output (`appHeight`).
 * Getting this wrong paints every band one row off — verified empirically in
 * painter-frame.integration.test.tsx. We save the cursor, move up
 * `cursorRow - row` to the band's top, write the payload, and restore. We
 * never erase before a same-position repaint (that was ink-picture's flash);
 * we only clear rows the image moved off of.
 */
import { vacatedRows, spansOverlap, type RowSpan } from "./geometry.js";

export interface PaintBox {
  /** App-relative top row (== absolute screen row; app root is at row 0). */
  row: number;
  col: number;
  rows: number;
  cols: number;
}

const up = (n: number): string => (n > 0 ? `\x1b[${n}A` : "");
const fwd = (n: number): string => (n > 0 ? `\x1b[${n}C` : "");

/**
 * @param payload protocol band escapes to display (sixel/iTerm2/kitty placement)
 * @param box     where to show it now, or null when nothing should show
 * @param prev    what was shown last frame (for vacated-row erase), or null
 * @param cursorRow 0-based app row the cursor is parked ON when this runs
 *   (fullscreen: `appHeight - 1`; non-fullscreen: `appHeight` — see header)
 * @param occluders rows owned by opaque overlays (modals). A vacated row inside
 *   an occluder must NOT be space-erased: the modal already painted that row
 *   opaque this frame, and our erase would punch a hole through it. (This was
 *   the "modals hidden by image" bug — the image's own vacated-row erase, fired
 *   the instant a modal covered it, blanked the modal where the image had been.)
 * @param isRowRepainted true when THIS frame's bytes already rewrote the given
 *   app row (from frameDamage.ts). A vacated row Ink just repainted must not
 *   be space-erased: on a scroll the old band rows get fresh narrative text in
 *   the same frame, and our erase (spliced after Ink's content) would wipe it
 *   — leaving permanent blank holes, because Ink's diff model still believes
 *   the text is on screen and never rewrites it. Rows Ink did NOT touch keep
 *   their stale pixels and are erased as before.
 */
export function composePaint(
  payload: string,
  box: PaintBox | null,
  prev: PaintBox | null,
  cursorRow: number,
  occluders: readonly RowSpan[] = [],
  isRowRepainted: (row: number) => boolean = () => false,
): string {
  if (!box && !prev) return "";
  let out = "\x1b7"; // save cursor
  const vac = vacatedRows(
    prev ? { top: prev.row, rows: prev.rows } : null,
    box ? { top: box.row, rows: box.rows } : null,
  )
    .filter((r) => !occluders.some((o) => spansOverlap({ top: r, rows: 1 }, o)))
    .filter((r) => !isRowRepainted(r));
  if (vac.length > 0 && prev) {
    for (const r of vac) {
      out += up(cursorRow - r) + "\r" + fwd(prev.col) + " ".repeat(prev.cols) + "\x1b8\x1b7";
    }
  }
  if (box && payload) {
    out += up(cursorRow - box.row) + "\r" + fwd(box.col) + payload;
  }
  out += "\x1b8"; // restore cursor
  return out;
}

/**
 * A cheap identity string for what the painter would blit this frame: the
 * on-screen box, the source-band offset (which pixels), the resting cursor row
 * (the cursor-up math), and the raster generation. Two frames with an equal
 * signature paint identical pixels at the identical place — so when the frame
 * left the image's rows untouched (see frameDamage.ts), the second frame's
 * re-blit is wasted work and can be skipped.
 *
 * Returns `null` when nothing is shown; hide/show and occlusion transitions
 * therefore always repaint (a null↔non-null change is never "unchanged"). The
 * string deliberately carries no payload bytes, so computing and comparing it
 * is O(1) regardless of image size.
 */
export function paintSignature(
  box: PaintBox | null,
  srcTopRows: number,
  cursorRow: number,
  rasterEpoch: number,
): string | null {
  if (!box) return null;
  return `${box.row},${box.col},${box.rows},${box.cols},${srcTopRows},${cursorRow},${rasterEpoch}`;
}
