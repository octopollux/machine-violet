/**
 * Protocol-driver abstraction for the inline-image renderer.
 *
 * Two families:
 *  - blit (sixel, iTerm2): dumb pixel payload at the cursor, no native crop,
 *    clobbered by Ink's per-frame redraw. `encodeBand` is expensive
 *    (re-encode the cropped band) so the component debounces + caches it; the
 *    cached payload is re-blitted every frame inside the sync-output block.
 *  - placement (kitty): transmit-once by image ID, native source-rect crop,
 *    flicker-free cheap re-place. `encodeBand` is cheap (a placement escape).
 *
 * The component owns cursor positioning, vacated-row erase, and footprint
 * reservation (see paint.ts); a driver only knows how to cache a raster and
 * produce the protocol payload for a visible source band.
 */
import type { GraphicsProtocol } from "../capabilities.js";

export interface PreparedImage {
  /**
   * Protocol payload that displays the source pixel band [topPx, topPx+bandPx)
   * once the cursor is parked at the band's top-left. For blit protocols this
   * is the encoded band (sixel/PNG); for kitty it is a crop placement command.
   */
  encodeBand(topPx: number, bandPx: number): string;
  /**
   * Escapes to remove a currently-displayed band when it stops being shown
   * (scrolled off, occluded by a modal). Blit protocols (sixel/iTerm2) return
   * nothing — their pixels are simply not re-blitted and the covering content
   * overwrites them. Kitty's placement persists independently of the text grid,
   * so it must explicitly delete the placement here (keeping the transmitted
   * image data so it can be re-placed when shown again). Optional; absent ≡ "".
   */
  clear?(): string;
  /** Release any terminal-side resources (kitty deletes its transmitted image). */
  dispose(): void;
}

export interface ImageDriver {
  readonly protocol: GraphicsProtocol;
  /**
   * True when `encodeBand` is expensive and must be debounced + cached
   * (blit family). False when it is cheap enough to call per-frame (kitty).
   */
  readonly expensiveEncode: boolean;
  /**
   * Cache (and for kitty, transmit) the resized RGBA raster. `write` lets a
   * driver emit out-of-band transmit escapes once at prepare time. `paletteSize`
   * is the sixel color-register budget (ignored by non-palettized protocols).
   */
  prepare(rgba: Buffer, widthPx: number, heightPx: number, write: (s: string) => void, paletteSize: number): PreparedImage;
}
