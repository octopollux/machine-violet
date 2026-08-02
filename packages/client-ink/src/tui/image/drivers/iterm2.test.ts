/**
 * iTerm2 driver — verified by decoding the PNG it embeds back through sharp and
 * confirming it is exactly the requested source band, at the requested display
 * size. (The escape wrapper is grammar; the pixels are the contract.)
 */
import sharp from "sharp";
import { iterm2Driver } from "./iterm2.js";

const W = 12, H = 18;
const CELL = { width: 6, height: 6 }; // → cols=2; a 6px band = 1 row, 12px = 2 rows

function sampleRgba(): Buffer {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = (x * 21) & 0xff;
    rgba[i + 1] = (y * 14) & 0xff;
    rgba[i + 2] = 100;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/** Pull the base64 PNG out of an `OSC 1337 ; File=…:<b64><BEL>` escape. */
function pngFromEscape(esc: string): Buffer {
  expect(esc.startsWith("\x1b]1337;File=")).toBe(true);
  expect(esc.endsWith("\x07")).toBe(true);
  const b64 = esc.slice(esc.indexOf(":") + 1, -1);
  return Buffer.from(b64, "base64");
}

describe("iterm2Driver", () => {
  it("is a cheap (real-time) encoder", () => {
    expect(iterm2Driver.expensiveEncode).toBe(false);
  });

  it("returns empty string for a zero-height band", () => {
    const p = iterm2Driver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    expect(p.encodeBand(0, 0)).toBe("");
  });

  it("sizes the display in CELLS, not pixels, so it lands on the text grid", () => {
    const p = iterm2Driver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    const esc = p.encodeBand(6, 12); // 12px band ÷ 6px cell = 2 rows; W/6 = 2 cols
    // Only the header is grammar — the base64 payload after ":" can contain
    // any substring, so assert on the header alone.
    const header = esc.slice(0, esc.indexOf(":"));
    expect(header).toContain("width=2;height=2"); // cells (no "px")
    expect(header).not.toContain("px");
    expect(header).toContain("inline=1");
  });

  it("memoizes repeated bands (LRU) and stays correct after eviction", () => {
    const p = iterm2Driver.prepare(sampleRgba(), W, H, () => {}, 256, CELL);
    const first = p.encodeBand(0, 6);
    expect(p.encodeBand(0, 6)).toBe(first); // memo hit → identical output
    // Churn well past the LRU cap, then re-request the original band.
    for (let top = 0; top < 12; top++) p.encodeBand(top, 6);
    expect(p.encodeBand(0, 6)).toBe(first); // re-encoded after eviction, same bytes
  });

  it("embeds a PNG that decodes to exactly the requested band", async () => {
    const src = sampleRgba();
    const p = iterm2Driver.prepare(src, W, H, () => {}, 256, CELL);
    const top = 6, rows = 6;
    const png = pngFromEscape(p.encodeBand(top, rows));
    const { data, info } = await sharp(png).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(W);
    expect(info.height).toBe(rows);
    // Band [top, top+rows) of the source must equal the decoded pixels.
    const want = src.subarray(top * W * 4, (top + rows) * W * 4);
    expect([...data]).toEqual([...want]);
  });
});
