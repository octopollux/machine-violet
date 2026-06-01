/**
 * Minimal synchronous PNG encoder (8-bit RGBA, color type 6).
 *
 * The iTerm2 inline-image protocol wants a real image FILE (not raw pixels), and
 * `encodeBand` is synchronous — so we can't reach for `sharp` (async) there. Node's
 * built-in `zlib.deflateSync` gives us proper compression with no extra dependency,
 * so we frame a standard PNG by hand: signature + IHDR + IDAT(deflate) + IEND.
 *
 * Scope is deliberately tiny: one fixed format (RGBA8, no interlace, filter 0 per
 * scanline). That's all the renderer needs — the source is already a contiguous
 * RGBA buffer from sharp.
 */
import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32 (IEEE) table — PNG chunk checksums.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Frame one PNG chunk: length, type, data, CRC(type+data). */
function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode an RGBA8888 pixel buffer (`width*height*4` bytes, row-major) to a PNG.
 * @throws if `rgba.length` doesn't match the geometry.
 */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`encodePng: expected ${stride * height} bytes, got ${rgba.length}`);
  }

  // IHDR: width, height, bit depth 8, color type 6 (RGBA), default compression/
  // filter/interlace methods.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data = each scanline prefixed by its filter-type byte (0 = none).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
