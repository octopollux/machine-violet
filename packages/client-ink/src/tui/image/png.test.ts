/**
 * The PNG encoder is verified by round-trip: encode a known RGBA buffer, then
 * decode it back with sharp and confirm the pixels survive intact. Decoding with
 * a real, independent codec is the strongest check the framing/CRC/deflate are
 * all correct.
 */
import sharp from "sharp";
import { encodePng } from "./png.js";

const W = 7, H = 5; // tiny + odd dims to catch stride bugs

function gradient(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = (x * 37) & 0xff;
    rgba[i + 1] = (y * 51) & 0xff;
    rgba[i + 2] = ((x + y) * 19) & 0xff;
    rgba[i + 3] = x === 0 ? 0 : 255; // first column transparent
  }
  return rgba;
}

describe("encodePng", () => {
  it("emits a valid PNG signature and IHDR/IEND chunks", () => {
    const png = encodePng(gradient(), W, H);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.includes(Buffer.from("IHDR"))).toBe(true);
    expect(png.includes(Buffer.from("IDAT"))).toBe(true);
    expect(png.includes(Buffer.from("IEND"))).toBe(true);
  });

  it("round-trips through sharp with pixels intact (incl. alpha)", async () => {
    const src = gradient();
    const png = encodePng(src, W, H);
    const { data, info } = await sharp(png).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(W);
    expect(info.height).toBe(H);
    expect([...data]).toEqual([...src]);
  });

  it("throws on a geometry mismatch", () => {
    expect(() => encodePng(new Uint8Array(10), W, H)).toThrow(/expected/);
  });
});
