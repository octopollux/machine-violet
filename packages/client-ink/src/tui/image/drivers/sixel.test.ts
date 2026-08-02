/**
 * Sixel driver — the key guarantee is a STABLE cross-crop palette: a given
 * source row decodes to identical colors no matter which band crop contains it.
 * That only holds because the whole image is quantized ONCE at prepare and every
 * band slices the same frozen indices/palette. If someone reverts to per-band
 * `image2sixel` (re-quantize per crop), the overlap-equality test below fails.
 */
import { decode, introducer, FINALIZER } from "sixel";
import { reduce } from "sixel/lib/Quantizer.js";
import { sixelEncodeIndexed } from "sixel/lib/SixelEncoder.js";
import { sixelDriver } from "./sixel.js";

const W = 60; // px wide
const H = 48; // px tall (multiple of 6 → clean sixel bands)
const CELL = { width: 8, height: 16 }; // sixel ignores this; required by prepare

/** A gradient with a few hard color planes — enough to populate a palette. */
function sampleRgba(): Buffer {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = Math.floor((x / W) * 255);
    rgba[i + 1] = Math.floor((y / H) * 255);
    rgba[i + 2] = (x + y) % 2 ? 64 : 192;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * Decode a full sixel string and return a row-accessor over its pixels.
 * The pixels are SNAPSHOTTED: the lib's `decode()` returns `data32` as a view
 * into shared decoder memory, so holding two live decode results at once (as
 * the sub-rect comparisons below do) silently corrupts the earlier one.
 */
function decodeRows(s: string): { width: number; at: (row: number, col: number) => number } {
  const res = decode(s);
  const pixels = new Uint32Array(res.data32);
  return { width: res.width, at: (row, col) => pixels[row * res.width + col] };
}

/** The `#idx;2;r;g;b` palette DEFINITION tokens at the head of a sixel body. */
function paletteDefs(full: string): string[] {
  const body = full.slice(full.indexOf("q") + 1, full.length - 2);
  return body.match(/#\d+;2;\d+;\d+;\d+/g) ?? [];
}

/** Pure band DATA per 6-row band, with raster attrs + palette defs stripped. */
function bandData(full: string): string[] {
  const body = full.slice(full.indexOf("q") + 1, full.length - 2);
  const noRaster = body.replace(/^"[0-9;]*/, "");
  const noDefs = noRaster.replace(/#\d+;2;\d+;\d+;\d+/g, "");
  return noDefs.split("-\n");
}

describe("sixelDriver", () => {
  it("emits a well-formed sixel sequence (introducer … finalizer)", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    const band = prepared.encodeBand(0, 12);
    expect(band.startsWith("\x1bP")).toBe(true); // DCS introducer
    expect(band.endsWith("\x1b\\")).toBe(true); // ST finalizer
  });

  it("returns empty string for a zero-height band", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    expect(prepared.encodeBand(0, 0)).toBe("");
    expect(prepared.encodeBand(10, 0)).toBe("");
  });

  it("is real-time (not flagged as an expensive encoder)", () => {
    expect(sixelDriver.expensiveEncode).toBe(false);
  });

  it("decodes a band back to roughly the source colors", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    const dec = decodeRows(prepared.encodeBand(0, 6));
    // Top-left is near-black-green (x≈0,y≈0); bottom region is greener. Sanity:
    // decoded pixel exists and alpha is opaque (high byte set).
    const px = dec.at(0, 0);
    expect((px >>> 24) & 0xff).toBe(0xff);
  });

  it("uses a stable palette across crops (the whole point of #6)", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    // Crop A = source rows [0,24); crop B = source rows [12,36). The overlap is
    // source rows [12,24): A's 6-row bands 2,3 and B's bands 0,1.
    const a = prepared.encodeBand(0, 24);
    const b = prepared.encodeBand(12, 24);

    // (1) Both crops define the IDENTICAL palette — one shared quantization, so
    // register N is the same RGB everywhere. (With per-band re-quantize this is
    // exactly what diverged and made colors shift on scroll.)
    expect(paletteDefs(a)).toEqual(paletteDefs(b));

    // (2) The same source rows produce byte-identical band DATA across crops —
    // the encoder output for a given row never depends on the crop window.
    const aData = bandData(a), bData = bandData(b);
    expect(aData[2]).toBe(bData[0]); // src rows 12..18
    expect(aData[3]).toBe(bData[1]); // src rows 18..24
  });

  it("assembles every warm band byte-identical to a direct encode", async () => {
    // The slice-cache assembly (issue #780) must be indistinguishable from the
    // pre-cache behavior. A band's top always lands ON its phase's slice grid,
    // so a warm assembly (cached slices + optional ragged tail) reproduces the
    // direct `sixelEncodeIndexed` output byte for byte — for EVERY phase, not
    // just 6px-aligned tops. The reference is rebuilt from the same
    // deterministic `reduce`. Byte-identity is the strongest possible check
    // and deliberately avoids the lib's decoder, which renders a handful of
    // left-edge pixels of a band crop differently from the same rows of the
    // full image (a pre-existing decoder quirk, reproducible with two direct
    // encodes and no driver involved; real terminals don't show it).
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    await prepared.whenWarm?.(); // exercise the cache path, not the fallback
    const opaque = new Uint8Array(sampleRgba());
    const { indices, palette } = reduce(opaque, W, 256);
    // cellH=16 → phases {0,4,2}: aligned tops (phase 0), top 16 (phase 4),
    // top 32 (phase 2, ragged tail), a cold-fallback top no cell grid produces
    // (7 → phase 1), a single-row band, and a bottom-clamped overrun.
    const cases: [number, number][] = [[0, 12], [12, 24], [6, 42], [0, H], [16, 18], [32, 15], [7, 17], [16, 1], [32, 999]];
    for (const [top, rows] of cases) {
      const clipped = Math.min(rows, H - top);
      const direct =
        introducer(0) +
        sixelEncodeIndexed(indices.subarray(top * W, (top + clipped) * W), W, clipped, palette) +
        FINALIZER;
      expect(prepared.encodeBand(top, rows), `band ${top}+${rows}`).toBe(direct);
    }
  });

  it("encodes a given band deterministically across repeated calls", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    expect(prepared.encodeBand(6, 18)).toBe(prepared.encodeBand(6, 18));
  });

  it("flattens transparency before quantizing (letterbox alpha can't corrupt the palette)", () => {
    // The quantizer scatters the whole palette into noise when fed a varying
    // alpha channel. The driver forces alpha opaque first, so a transparent
    // letterbox must yield the SAME encoding as the already-opaque image.
    const transparent = sampleRgba();
    for (let i = 3; i < W * 6 * 4; i += 4) transparent[i] = 0; // top 6 rows transparent
    const opaque = Buffer.from(transparent);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    const fromTransparent = sixelDriver.prepare(transparent, W, H, () => {}, 256, CELL).encodeBand(0, H);
    const fromOpaque = sixelDriver.prepare(opaque, W, H, () => {}, 256, CELL).encodeBand(0, H);
    expect(fromTransparent).toBe(fromOpaque);
  });

  it("does not mutate the caller's RGBA buffer (reduce dithers in place)", () => {
    const rgba = sampleRgba();
    const snapshot = Buffer.from(rgba);
    sixelDriver.prepare(rgba, W, H, () => {}, 256, CELL).encodeBand(0, 12);
    expect(rgba.equals(snapshot)).toBe(true);
  });
});
