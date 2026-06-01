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
 * Fit an image inside a cell bounding box at its true aspect ratio, returning
 * the footprint (in cells) to reserve and paint.
 *
 * The parent passes BOUNDS (max cols, max rows), not a fixed footprint, so the
 * image — not the parent — owns aspect: it grows to fill width, and only when
 * that would overflow the row cap does it switch to filling height instead.
 * This removes the old double-letterbox (parent reserved a 16:9 box, the
 * component then `fit:contain`-ed the source into it, padding twice).
 *
 * Terminal cells are taller than wide, so a pixel aspect must be converted to a
 * cell aspect: a WxH-pixel image wants `usedCols·cellW / (usedRows·cellH) = W/H`.
 */
export function fitImage(
  natWidthPx: number,
  natHeightPx: number,
  maxCols: number,
  maxRows: number,
  cell: { width: number; height: number },
): { cols: number; rows: number } {
  if (natWidthPx <= 0 || natHeightPx <= 0 || maxCols <= 0 || maxRows <= 0) {
    return { cols: Math.max(1, maxCols), rows: Math.max(1, Math.min(maxRows, maxCols)) };
  }
  // Fill width first; fall back to filling height when that overflows the cap.
  let cols = maxCols;
  let rows = Math.round((cols * cell.width * natHeightPx) / (cell.height * natWidthPx));
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.round((rows * cell.height * natWidthPx) / (cell.width * natHeightPx));
  }
  return {
    cols: Math.max(1, Math.min(cols, maxCols)),
    rows: Math.max(1, Math.min(rows, maxRows)),
  };
}

/**
 * Trim a visible band by the rows opaque overlays cover — the "vertical-only
 * partial occlusion" that lets an image keep showing the part a modal doesn't
 * cover, instead of vanishing whole.
 *
 * Out-of-band graphics have no z-order against Ink's text grid, so any row a
 * modal paints is a row the image must NOT paint. We model the image as one
 * contiguous band (a single blit), so:
 *  - an overlay covering the band's TOP edge pushes `visTop` down (and advances
 *    `srcTopRows`, so the source crop starts lower — the bookkeeping that keeps
 *    the remaining pixels aligned);
 *  - an overlay covering the BOTTOM edge pulls the bottom up;
 *  - an overlay strictly INSIDE the band splits it in two — we can't paint a
 *    doughnut, so we keep the larger half;
 *  - an overlay covering the whole band (e.g. a full-height side pane) hides it
 *    (returns null).
 *
 * Overlays are processed top-to-bottom so stacked trims compose. This is the
 * same coordinate space and return shape as `visibleBand`, so callers chain
 * them: viewport clip first, then occlusion.
 */
export function subtractOcclusion(
  band: VisibleBand,
  overlays: readonly RowSpan[],
): VisibleBand | null {
  let { visTop, srcTopRows } = band;
  let visBottom = visTop + band.visRows;
  const sorted = [...overlays].filter((o) => o.rows > 0).sort((a, b) => a.top - b.top);
  for (const o of sorted) {
    const oTop = o.top;
    const oBottom = o.top + o.rows;
    if (oBottom <= visTop || oTop >= visBottom) continue; // no overlap
    const coversTop = oTop <= visTop;
    const coversBottom = oBottom >= visBottom;
    if (coversTop && coversBottom) return null; // fully covered
    if (coversTop) {
      srcTopRows += oBottom - visTop;
      visTop = oBottom;
    } else if (coversBottom) {
      visBottom = oTop;
    } else {
      // Strictly interior: keep the larger of the two surviving segments.
      const topRows = oTop - visTop;
      const bottomRows = visBottom - oBottom;
      if (topRows >= bottomRows) {
        visBottom = oTop;
      } else {
        srcTopRows += oBottom - visTop;
        visTop = oBottom;
      }
    }
    if (visBottom <= visTop) return null;
  }
  return { visTop, visRows: visBottom - visTop, srcTopRows };
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
