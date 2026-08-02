/**
 * iTerm2 driver (blit family — same shape as sixel).
 *
 * The iTerm2 inline-image protocol (`OSC 1337 ; File=…`) blits an image file at
 * the cursor with no native cropping, so each visible band is its own PNG of just
 * that band's rows, re-blitted every frame inside the sync-output block. Hiding
 * works exactly like sixel: the painter stops re-blitting and the covering
 * modal's text overwrites the pixels.
 *
 * `encodeBand` PNG-encodes a band. Measured on real scene art at full-pane
 * geometry (issue #780, `image-encode-bench.ts`): the default deflate cost
 * ~40-100ms per band — far from the "1-3ms" this file once claimed — so the
 * encode uses the fast `Z_RLE` PNG path (~3× faster, ~11% larger; the payload
 * is transient screen data) and memoizes recent bands in a small LRU so scroll
 * reversals and the steady-state reblit re-encode nothing.
 */
import { encodePng } from "../png.js";
import type { ImageDriver, PreparedImage } from "./types.js";

/**
 * OSC 1337 inline image: display `png` at exactly `cols`×`rows` character cells.
 * Sizing in cells (no `px` suffix) — rather than pixels — makes the image
 * occupy exactly the text rows the renderer reserved, so it stays aligned with
 * the scroll/occlusion math even when the terminal's pixel cell height is only
 * approximate (iTerm2 answers 14t, not 16t, so our cell size is derived).
 */
function iterm2Escape(png: Buffer, cols: number, rows: number): string {
  const header = `size=${png.length};width=${cols};height=${rows};preserveAspectRatio=0;inline=1`;
  return `\x1b]1337;File=${header}:${png.toString("base64")}\x07`;
}

/** Bands memoized per prepared image; a scroll gesture revisits few offsets. */
const BAND_MEMO_CAP = 8;

export const iterm2Driver: ImageDriver = {
  protocol: "iterm2",
  // Z_RLE PNG per band (~16ms full-pane) + LRU memo → real-time.
  expensiveEncode: false,
  prepare(rgba: Buffer, widthPx: number, _heightPx: number, _write: (s: string) => void, _paletteSize: number, cellPixels: { width: number; height: number }): PreparedImage {
    const stride = widthPx * 4;
    const cols = Math.round(widthPx / cellPixels.width);
    // Insertion-ordered Map as LRU: hit → re-insert; overflow → evict oldest.
    const memo = new Map<string, string>();
    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        const key = `${topPx}:${bandPx}`;
        const hit = memo.get(key);
        if (hit !== undefined) {
          memo.delete(key);
          memo.set(key, hit);
          return hit;
        }
        const band = rgba.subarray(topPx * stride, (topPx + bandPx) * stride);
        const rows = Math.round(bandPx / cellPixels.height);
        const out = iterm2Escape(encodePng(band, widthPx, bandPx, true), cols, rows);
        memo.set(key, out);
        if (memo.size > BAND_MEMO_CAP) memo.delete(memo.keys().next().value as string);
        return out;
      },
      dispose() {
        memo.clear(); // iTerm2 holds no addressable terminal-side resource
      },
    };
  },
};
