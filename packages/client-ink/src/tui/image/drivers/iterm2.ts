/**
 * iTerm2 driver (blit family — same shape as sixel).
 *
 * The iTerm2 inline-image protocol (`OSC 1337 ; File=…`) blits an image file at
 * the cursor with no native cropping, so each visible band is its own PNG of just
 * that band's rows, re-blitted every frame inside the sync-output block. Hiding
 * works exactly like sixel: the painter stops re-blitting and the covering
 * modal's text overwrites the pixels.
 *
 * `encodeBand` PNG-encodes a band (`zlib.deflateSync` under the hood). That
 * measures ~1-3ms per band — same order as slicing a sixel — so it's treated as
 * a cheap encoder (real-time, no debounce). The per-frame reblit cost is the
 * cached payload either way; only the re-encode cadence differs. (If a very
 * large/high-entropy image ever janks on a real iTerm2, flip this to true to
 * debounce edge re-encodes — the reblit path is unaffected.)
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

export const iterm2Driver: ImageDriver = {
  protocol: "iterm2",
  // PNG-deflate per band is ~1-3ms → cheap enough to re-encode in real time.
  expensiveEncode: false,
  prepare(rgba: Buffer, widthPx: number, _heightPx: number, _write: (s: string) => void, _paletteSize: number, cellPixels: { width: number; height: number }): PreparedImage {
    const stride = widthPx * 4;
    const cols = Math.round(widthPx / cellPixels.width);
    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        const band = rgba.subarray(topPx * stride, (topPx + bandPx) * stride);
        const rows = Math.round(bandPx / cellPixels.height);
        return iterm2Escape(encodePng(band, widthPx, bandPx), cols, rows);
      },
      dispose() {
        /* iTerm2 holds no addressable terminal-side resource */
      },
    };
  },
};
