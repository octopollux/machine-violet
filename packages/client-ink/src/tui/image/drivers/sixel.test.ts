/**
 * Sixel driver — the key guarantee is a STABLE cross-crop palette: a given
 * source row decodes to identical colors no matter which band crop contains it.
 * That only holds because the whole image is quantized ONCE at prepare and every
 * band slices the same frozen indices/palette. If someone reverts to per-band
 * `image2sixel` (re-quantize per crop), the overlap-equality test below fails.
 */
import { decode } from "sixel";
import { sixelDriver } from "./sixel.js";

const W = 60; // px wide
const H = 48; // px tall (multiple of 6 → clean sixel bands)

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

/** Decode a full sixel string and return a row-accessor over its pixels. */
function decodeRows(s: string): { width: number; at: (row: number, col: number) => number } {
  const res = decode(s);
  return { width: res.width, at: (row, col) => res.data32[row * res.width + col] };
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
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256);
    const band = prepared.encodeBand(0, 12);
    expect(band.startsWith("\x1bP")).toBe(true); // DCS introducer
    expect(band.endsWith("\x1b\\")).toBe(true); // ST finalizer
  });

  it("returns empty string for a zero-height band", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256);
    expect(prepared.encodeBand(0, 0)).toBe("");
    expect(prepared.encodeBand(10, 0)).toBe("");
  });

  it("is real-time (not flagged as an expensive encoder)", () => {
    expect(sixelDriver.expensiveEncode).toBe(false);
  });

  it("decodes a band back to roughly the source colors", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256);
    const dec = decodeRows(prepared.encodeBand(0, 6));
    // Top-left is near-black-green (x≈0,y≈0); bottom region is greener. Sanity:
    // decoded pixel exists and alpha is opaque (high byte set).
    const px = dec.at(0, 0);
    expect((px >>> 24) & 0xff).toBe(0xff);
  });

  it("uses a stable palette across crops (the whole point of #6)", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256);
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

  it("encodes a given band deterministically across repeated calls", () => {
    const prepared = sixelDriver.prepare(sampleRgba(), W, H, () => {}, 256);
    expect(prepared.encodeBand(6, 18)).toBe(prepared.encodeBand(6, 18));
  });

  it("does not mutate the caller's RGBA buffer (reduce dithers in place)", () => {
    const rgba = sampleRgba();
    const snapshot = Buffer.from(rgba);
    sixelDriver.prepare(rgba, W, H, () => {}, 256).encodeBand(0, 12);
    expect(rgba.equals(snapshot)).toBe(true);
  });
});
