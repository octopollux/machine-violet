/**
 * Composes the terminal escape string that blits an image band at an absolute
 * position, with targeted erase of rows a previous paint vacated.
 *
 * Shared by all protocols: the cursor sits at the app's bottom when this runs
 * (we splice it just before ESU, after Ink's frame content), so we save the
 * cursor, move up `appHeight - row` to the band's top, write the payload, and
 * restore. We never erase before a same-position repaint (that was ink-picture's
 * flash); we only clear rows the image moved off of.
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
 * @param appHeight total app height in rows (cursor parks at the bottom)
 * @param occluders rows owned by opaque overlays (modals). A vacated row inside
 *   an occluder must NOT be space-erased: the modal already painted that row
 *   opaque this frame, and our erase would punch a hole through it. (This was
 *   the "modals hidden by image" bug — the image's own vacated-row erase, fired
 *   the instant a modal covered it, blanked the modal where the image had been.)
 */
export function composePaint(
  payload: string,
  box: PaintBox | null,
  prev: PaintBox | null,
  appHeight: number,
  occluders: readonly RowSpan[] = [],
): string {
  if (!box && !prev) return "";
  let out = "\x1b7"; // save cursor
  const vac = vacatedRows(
    prev ? { top: prev.row, rows: prev.rows } : null,
    box ? { top: box.row, rows: box.rows } : null,
  ).filter((r) => !occluders.some((o) => spansOverlap({ top: r, rows: 1 }, o)));
  if (vac.length > 0 && prev) {
    for (const r of vac) {
      out += up(appHeight - r) + "\r" + fwd(prev.col) + " ".repeat(prev.cols) + "\n" + "\x1b8\x1b7";
    }
  }
  if (box && payload) {
    out += up(appHeight - box.row) + "\r" + fwd(box.col) + payload;
  }
  out += "\x1b8"; // restore cursor
  return out;
}

/**
 * A cheap identity string for what the painter would blit this frame: the
 * on-screen box, the source-band offset (which pixels), the app height (the
 * cursor-up math), and the raster generation. Two frames with an equal
 * signature paint identical pixels at the identical place — so under
 * incremental rendering, where Ink leaves the image's unchanged (blank) slot
 * rows untouched, the second frame's re-blit is wasted work and can be skipped.
 *
 * Returns `null` when nothing is shown; hide/show and occlusion transitions
 * therefore always repaint (a null↔non-null change is never "unchanged"). The
 * string deliberately carries no payload bytes, so computing and comparing it
 * is O(1) regardless of image size.
 */
export function paintSignature(
  box: PaintBox | null,
  srcTopRows: number,
  appHeight: number,
  rasterEpoch: number,
): string | null {
  if (!box) return null;
  return `${box.row},${box.col},${box.rows},${box.cols},${srcTopRows},${appHeight},${rasterEpoch}`;
}
