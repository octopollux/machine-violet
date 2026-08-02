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
 * PER-PHASE SLICE CACHES (issue #780). Encoding a band from the frozen indices
 * is NOT cheap at full-pane geometry — measured ~50-130ms per scroll step on
 * real scene art at 1024 colors (the encoder's inner loop is O(width ×
 * colors-used) per pixel column). A sixel stream is a sequence of 6-pixel-row
 * band chunks joined by `-\n`, so chunks can be pre-encoded once and reused —
 * BUT the `-` separator always advances exactly 6 rows, so every chunk except
 * the last must be a full 6-row slice starting exactly at the band's own 6px
 * grid. A band's grid alignment is `topPx % 6` (its PHASE), and topPx is always
 * a multiple of the terminal's cell height, so only a handful of phases ever
 * occur (e.g. cellH=20 → {0,2,4}; cellH=18 → {0}). `prepare` derives that
 * phase set from cellPixels and pre-encodes one slice cache per phase —
 * ASYNCHRONOUSLY, one slice per event-loop turn, so the one-time whole-image
 * cost (~130ms/phase at full-pane size) never blocks input or a frame.
 * `encodeBand` assembles a warm band as cached-slice joins + at most one tiny
 * ragged-tail encode (~2-5ms); until the needed phase is warm it falls back to
 * the direct whole-band encode (the pre-#780 behavior, correct but slow). For
 * a phase-0 band the assembled output is byte-identical to the direct encode
 * (asserted in sixel.test.ts).
 */
import { introducer, FINALIZER } from "sixel";
import { reduce } from "sixel/lib/Quantizer.js";
import { sixelEncodeIndexed } from "sixel/lib/SixelEncoder.js";
import type { ImageDriver, PreparedImage } from "./types.js";

/** `#idx;2;r;g;b` palette-definition run at the head of an encoder output. */
const PALETTE_DEFS_RE = /^(?:#\d+;2;\d+;\d+;\d+)+/;

interface PhaseCache {
  /** slices[j] encodes source rows [phase + 6j, phase + 6j + 6). */
  slices: string[];
  /** All slices encoded — assembly may use this cache. */
  warm: boolean;
}

export const sixelDriver: ImageDriver = {
  protocol: "sixel",
  // One quantization up front, then cheap per-band assembly from cached slices
  // (direct-encode fallback while a phase cache is still warming).
  expensiveEncode: false,
  prepare(rgba: Buffer, widthPx: number, _heightPx: number, _write: (s: string) => void, paletteSize: number, cellPixels: { width: number; height: number }): PreparedImage {
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
    const heightPx = indices.length / widthPx;

    // Encode source rows [a, b) as a bare band-data string: the encoder's
    // output minus its palette-definition prefix (defs are emitted once per
    // payload, captured below). Subarray views are safe: sixelEncodeIndexed
    // indexes the typed array directly and respects byteOffset, unlike
    // image2sixel's quantizer which reinterprets .buffer.
    const encodeRows = (a: number, b: number): string =>
      sixelEncodeIndexed(indices.subarray(a * widthPx, b * widthPx), widthPx, b - a, palette, false)
        .replace(PALETTE_DEFS_RE, "");

    // The shared `#idx;2;r;g;b` register-definition prefix every payload emits.
    const paletteDefs =
      sixelEncodeIndexed(indices.subarray(0, widthPx), widthPx, 1, palette, false)
        .match(PALETTE_DEFS_RE)?.[0] ?? "";

    // Band tops are srcTopRows*cellH, so the only phases (topPx % 6) that can
    // occur cycle with k*cellH mod 6 — at most 6, typically 1-3.
    const phases = new Set<number>();
    for (let k = 0; k < 6; k++) phases.add((k * Math.max(1, Math.round(cellPixels.height))) % 6);

    const caches = new Map<number, PhaseCache>();
    let disposed = false;
    // Warm every possible phase off the render path: one slice per event-loop
    // turn keeps each chunk of synchronous work at ~1-2ms.
    const warmQueue: { cache: PhaseCache; top: number }[] = [];
    for (const phase of [...phases].sort((a, b) => a - b)) {
      const cache: PhaseCache = { slices: [], warm: false };
      caches.set(phase, cache);
      for (let top = phase; top < heightPx; top += 6) warmQueue.push({ cache, top });
    }
    let warmIdx = 0;
    const pump = (): void => {
      if (disposed || warmIdx >= warmQueue.length) return;
      const { cache, top } = warmQueue[warmIdx++];
      cache.slices.push(encodeRows(top, Math.min(top + 6, heightPx)));
      if (warmIdx >= warmQueue.length || warmQueue[warmIdx].cache !== cache) cache.warm = true;
      setImmediate(pump);
    };
    setImmediate(pump);

    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        const bottomPx = Math.min(topPx + bandPx, heightPx);
        if (bottomPx <= topPx) return "";
        const phase = topPx % 6;
        const cache = caches.get(phase);
        if (!cache?.warm) {
          // Cold path (cache still warming, or an unexpected phase): direct
          // whole-band encode — the pre-#780 behavior.
          return (
            introducer(0) +
            sixelEncodeIndexed(indices.subarray(topPx * widthPx, bottomPx * widthPx), widthPx, bottomPx - topPx, palette) +
            FINALIZER
          );
        }
        // Warm path: the band starts ON the phase grid by construction, so it
        // is whole cached slices + at most one ragged tail (< 6 rows), which is
        // legal as the FINAL chunk (`-` advances a full 6 rows, so only the
        // last chunk may be short).
        const parts: string[] = [];
        let pos = topPx;
        while (pos + 6 <= bottomPx) {
          parts.push(cache.slices[(pos - phase) / 6]);
          pos += 6;
        }
        if (pos < bottomPx) parts.push(encodeRows(pos, bottomPx));
        return (
          introducer(0) +
          `"1;1;${widthPx};${bottomPx - topPx}` +
          paletteDefs +
          parts.join("-\n") +
          FINALIZER
        );
      },
      whenWarm(): Promise<void> {
        return new Promise((resolve) => {
          const check = (): void => {
            if (disposed || warmIdx >= warmQueue.length) resolve();
            else setImmediate(check);
          };
          check();
        });
      },
      dispose() {
        disposed = true; // stops the warm pump; sixel holds no terminal-side resource
        caches.clear();
      },
    };
  },
};
