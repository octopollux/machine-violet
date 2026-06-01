/**
 * Sixel driver (blit family). Reference implementation validated by the #552
 * spikes and the decode-verify harness.
 *
 * Quantizes the whole image ONCE (`reduce`) at `prepare` time, caching the
 * per-pixel `indices` and the shared `palette`. Each visible band is then
 * encoded with `sixelEncodeIndexed` over a slice of those fixed indices against
 * the shared palette. This is exactly what `image2sixel` does internally for a
 * full image (`introducer + sixelEncodeIndexed(reduce(...)) + FINALIZER` —
 * verified byte-identical), but split so every crop reuses one quantization.
 *
 * Why not re-`image2sixel` per band: that re-quantizes each band independently,
 * so the palette differs between crops and colors visibly shift while scrolling
 * across a viewport edge. A single shared palette + frozen indices makes a given
 * pixel render the same color in every band it appears in — no cross-crop shift.
 * (The earlier "stable palette" attempts failed only because they called
 * `reduce` twice — and `reduce` dithers in place, so the second call re-dithered
 * already-dithered data and produced a palette that didn't match the indices.)
 *
 * `paletteSize` is the terminal's XTSMGRAPHICS register count (clamped to
 * [256, 1024] upstream; terminals below 256 don't use sixel at all), giving
 * richer color on capable terminals.
 *
 * Per-band encode is ~3-8ms even at 1024 colors (the cost is the one-time
 * `reduce`, ~50-70ms, paid off the render path during decode), so this is
 * real-time — no debounce needed (`expensiveEncode: false`).
 */
import { introducer, FINALIZER } from "sixel";
import { reduce } from "sixel/lib/Quantizer.js";
import { sixelEncodeIndexed } from "sixel/lib/SixelEncoder.js";
import type { ImageDriver, PreparedImage } from "./types.js";

export const sixelDriver: ImageDriver = {
  protocol: "sixel",
  // One quantization up front, then cheap per-band encodes from cached indices.
  expensiveEncode: false,
  prepare(rgba: Buffer, widthPx: number, _heightPx: number, _write: (s: string) => void, paletteSize: number, _cellPixels: { width: number; height: number }): PreparedImage {
    // Flatten to opaque before quantizing. The quantizer mishandles a varying
    // alpha channel — the transparent letterbox from fit:"contain" — and
    // scatters the WHOLE palette into colored noise, not just the letterbox.
    // Sixel has no usable partial transparency anyway (the lib ignores it), so
    // force alpha to 255: the letterbox (RGB 0) becomes black bars, invisible on
    // a dark terminal. kitty/iTerm2 keep the real alpha for true transparency.
    // (This copy also protects the caller's cached RGBA — reduce dithers its
    // input in place.) Returns frozen indices (row-major Uint16Array, w*h) + the
    // shared RGBA8888 palette.
    const opaque = new Uint8Array(rgba);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    const { indices, palette } = reduce(opaque, widthPx, paletteSize);
    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        // A band is a clean rectangle of rows [topPx, topPx+bandPx) — slice the
        // fixed indices (subarray view is safe here: sixelEncodeIndexed indexes
        // the typed array directly and respects byteOffset, unlike image2sixel's
        // quantizer which reinterprets .buffer).
        const band = indices.subarray(topPx * widthPx, (topPx + bandPx) * widthPx);
        return introducer(0) + sixelEncodeIndexed(band, widthPx, bandPx, palette) + FINALIZER;
      },
      dispose() {
        /* sixel holds no terminal-side resource */
      },
    };
  },
};
