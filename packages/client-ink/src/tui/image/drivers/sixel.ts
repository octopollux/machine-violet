/**
 * Sixel driver (blit family). Reference implementation validated by the #552
 * spikes.
 *
 * prepare caches the resized RGBA once. encodeBand slices the visible pixel
 * band out of the cached buffer and runs image2sixel on just that band. The
 * encode is quantization-bound (~50-75ms at our sizes — NOT proportional to
 * pixels), so it is `expensiveEncode: true`: the component debounces it to
 * scroll-settle and re-blits the cached string every frame.
 *
 * Gotcha (from the perf spike): image2sixel's quantizer reads the underlying
 * ArrayBuffer and ignores byteOffset, so the band must be copied into a fresh
 * zero-offset Uint8Array — a subarray view fails its geometry check.
 */
import { image2sixel } from "sixel";
import type { ImageDriver, PreparedImage } from "./types.js";

export const sixelDriver: ImageDriver = {
  protocol: "sixel",
  expensiveEncode: true,
  prepare(rgba: Buffer, widthPx: number): PreparedImage {
    const stride = widthPx * 4; // RGBA
    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        const start = topPx * stride;
        const end = (topPx + bandPx) * stride;
        // Fresh contiguous copy — see gotcha above.
        const u8 = new Uint8Array(rgba.subarray(start, end));
        return image2sixel(u8, widthPx, bandPx);
      },
      dispose() {
        /* sixel holds no terminal-side resource */
      },
    };
  },
};
