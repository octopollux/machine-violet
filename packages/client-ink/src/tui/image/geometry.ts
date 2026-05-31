/**
 * Pure geometry for the inline-image renderer.
 *
 * Terminal graphics protocols paint pixels out of band at absolute screen
 * positions with no clipping. To compose with a scrolling, layered TUI we
 * crop each image to the band currently inside the viewport (vertical only —
 * images span the full narrative column, so horizontal crop is never needed)
 * and hide it when an overlay's row-span covers it.
 *
 * All functions here are coordinate-agnostic: callers pass row values in a
 * single consistent coordinate space (we use absolute terminal rows) and pixel
 * conversion uses the terminal's real cell height (queried via `\x1b[16t`).
 * Everything is a pure function so it can be unit-tested without a terminal.
 */

/** A contiguous span of terminal rows: `[top, top + rows)`. */
export interface RowSpan {
  top: number;
  rows: number;
}

/** Do two row spans overlap at all? Zero-height spans never overlap. */
export function spansOverlap(a: RowSpan, b: RowSpan): boolean {
  if (a.rows <= 0 || b.rows <= 0) return false;
  return a.top < b.top + b.rows && b.top < a.top + a.rows;
}

/** Does any of `overlays` overlap `image`? */
export function isOccluded(image: RowSpan, overlays: readonly RowSpan[]): boolean {
  return overlays.some((o) => spansOverlap(image, o));
}

/**
 * The portion of an image that falls inside a viewport, clipped vertically.
 *
 * @param imgTop   absolute row of the image's top edge (may be < viewTop when
 *                 the image is partly scrolled off the top)
 * @param imgRows  the image's full height in rows
 * @param viewTop  absolute row of the viewport's top edge
 * @param viewRows the viewport's height in rows
 * @returns the visible band, or `null` when nothing is visible
 *
 *   visTop     — absolute row where the visible band starts
 *   visRows    — height of the visible band in rows
 *   srcTopRows — how many image rows are clipped off the top (the source
 *                offset, in rows, to start the band from)
 */
export interface VisibleBand {
  visTop: number;
  visRows: number;
  srcTopRows: number;
}

export function visibleBand(
  imgTop: number,
  imgRows: number,
  viewTop: number,
  viewRows: number,
): VisibleBand | null {
  if (imgRows <= 0 || viewRows <= 0) return null;
  const imgBottom = imgTop + imgRows;
  const viewBottom = viewTop + viewRows;
  const visTop = Math.max(imgTop, viewTop);
  const visBottom = Math.min(imgBottom, viewBottom);
  const visRows = visBottom - visTop;
  if (visRows <= 0) return null;
  return { visTop, visRows, srcTopRows: visTop - imgTop };
}

/**
 * Convert a visible row band into the source pixel band to encode/place.
 * Uses the terminal's real cell height so the crop lands exactly on a cell
 * boundary (the "fiddly bit" — a wrong cell height shows as an off-by-one
 * misaligned image).
 */
export interface PixelBand {
  topPx: number;
  bandPx: number;
}

export function bandPixels(srcTopRows: number, visRows: number, cellHeightPx: number): PixelBand {
  return { topPx: srcTopRows * cellHeightPx, bandPx: visRows * cellHeightPx };
}

/**
 * Rows occupied by `prev` that `next` no longer covers — these must be erased
 * (overwritten with spaces) so a shrinking/moving image leaves no ghost band.
 * `next` of `null` means the image vanished entirely (erase all of `prev`).
 */
export function vacatedRows(prev: RowSpan | null, next: RowSpan | null): number[] {
  if (!prev || prev.rows <= 0) return [];
  const nextRows = new Set<number>();
  if (next) for (let r = next.top; r < next.top + next.rows; r++) nextRows.add(r);
  const out: number[] = [];
  for (let r = prev.top; r < prev.top + prev.rows; r++) if (!nextRows.has(r)) out.push(r);
  return out;
}
