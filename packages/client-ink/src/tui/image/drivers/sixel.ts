/**
 * Sixel driver (blit family). Reference implementation validated by the #552
 * spikes.
 *
 * Uses the public `image2sixel` to encode each visible band's RGBA directly —
 * the one sixel entry point in this lib that renders correctly and is
 * deterministic. (The lower-level `sixelEncodeIndexed` / `sixelEncode` + a
 * shared palette were tried for a stable cross-crop palette but produced wrong
 * output, so we don't use them.)
 *
 * `maxColors` is the terminal's XTSMGRAPHICS register count (clamped to
 * [256, 1024] upstream; terminals below 256 don't use sixel at all), giving
 * richer color on capable terminals.
 *
 * Trade-off: image2sixel re-quantizes per band, so the palette differs slightly
 * between crops — colors can shift while the visible band changes as you scroll
 * past a viewport edge. Steady, fully-visible images never re-encode, so the
 * shift is a transient only during edge-crossing scroll. A stable cross-crop
 * palette would need a different sixel encoder than this lib offers.
 */
import { image2sixel } from "sixel";
import type { ImageDriver, PreparedImage } from "./types.js";

export const sixelDriver: ImageDriver = {
  protocol: "sixel",
  // Per-band re-quantize is ~50-100ms (grows with palette size), so debounce
  // to scroll-settle and re-blit the cached payload each frame.
  expensiveEncode: true,
  prepare(rgba: Buffer, widthPx: number, _heightPx: number, _write: (s: string) => void, paletteSize: number): PreparedImage {
    const stride = widthPx * 4; // RGBA
    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        // Fresh contiguous copy of the band's RGBA (a subarray view trips
        // image2sixel's quantizer, which reinterprets the ArrayBuffer and
        // ignores byteOffset).
        const band = new Uint8Array(rgba.subarray(topPx * stride, (topPx + bandPx) * stride));
        return image2sixel(band, widthPx, bandPx, paletteSize);
      },
      dispose() {
        /* sixel holds no terminal-side resource */
      },
    };
  },
};
