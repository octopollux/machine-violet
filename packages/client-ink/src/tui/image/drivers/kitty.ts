/**
 * Kitty driver (placement family).
 *
 * Unlike the blit protocols, kitty transmits the full raster ONCE (at prepare,
 * as raw RGBA — `f=32` — so no encode step) keyed by an image id, then displays
 * any sub-rectangle with a cheap *placement* command that carries a native
 * source crop (`x,y,w,h`). So `encodeBand` is just a placement escape — cheap,
 * no debounce — and re-placing the same image+placement id at a new cursor
 * position is flicker-free by design.
 *
 * Because a placement persists independently of the text grid (a covering modal
 * won't overwrite it like it would sixel/iTerm2 pixels), `clear()` explicitly
 * deletes the placement when the band stops being shown — keeping the
 * transmitted image data so re-showing is just another placement. `dispose()`
 * deletes the image data itself.
 */
import type { ImageDriver, PreparedImage } from "./types.js";

// Monotonic image ids in kitty's recommended user range. A counter (not a
// random/time seed) keeps ids stable and collision-free within a session.
const ID_BASE = 0x100000;
let nextId = ID_BASE;

const ST = "\x1b\\"; // string terminator for the APC graphics escape

/** Transmit raw RGBA once, chunked (base64 ≤ 4096 per APC), suppressing replies. */
function transmit(write: (s: string) => void, id: number, rgba: Buffer, widthPx: number, heightPx: number): void {
  const b64 = rgba.toString("base64");
  const CHUNK = 4096;
  // f=32 raw RGBA, s/v = pixel dims, t=d direct transfer, i=id, q=2 quiet.
  for (let offset = 0, first = true; offset < b64.length || first; offset += CHUNK, first = false) {
    const piece = b64.slice(offset, offset + CHUNK);
    const more = offset + CHUNK < b64.length ? 1 : 0;
    const keys = first
      ? `f=32,s=${widthPx},v=${heightPx},t=d,i=${id},q=2,m=${more}`
      : `q=2,m=${more}`;
    write(`\x1b_G${keys};${piece}${ST}`);
    if (more === 0) break;
  }
}

export const kittyDriver: ImageDriver = {
  protocol: "kitty",
  // Placement is a tiny escape; encode per frame is fine.
  expensiveEncode: false,
  prepare(rgba: Buffer, widthPx: number, heightPx: number, write: (s: string) => void, _paletteSize: number, _cellPixels: { width: number; height: number }): PreparedImage {
    const id = nextId++;
    transmit(write, id, rgba, widthPx, heightPx);
    return {
      encodeBand(topPx: number, bandPx: number): string {
        if (bandPx <= 0) return "";
        // a=p place, p=1 single placement (re-place replaces it), x/y/w/h native
        // source crop, C=1 don't move cursor, q=2 quiet.
        return `\x1b_Ga=p,i=${id},p=1,x=0,y=${topPx},w=${widthPx},h=${bandPx},C=1,q=2${ST}`;
      },
      clear(): string {
        // d=i deletes placements for image id (keeps data → can re-place later).
        return `\x1b_Ga=d,d=i,i=${id},q=2${ST}`;
      },
      dispose(): void {
        // d=I deletes the image data and all its placements.
        write(`\x1b_Ga=d,d=I,i=${id},q=2${ST}`);
      },
    };
  },
};
