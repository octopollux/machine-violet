/**
 * MV-owned inline image renderer (issue #552). Replaces ink-picture's <Image>.
 *
 * Composes correctly with the live, scrolling, layered TUI:
 *  - decode + resize ONCE (sharp), cache raw RGBA (avoids the re-decode CPU
 *    meltdown); letterbox to a stable footprint with fit:"contain" so aspect is
 *    preserved and the reserved Box never jumps;
 *  - vertical band crop: only the rows inside the narrative viewport are
 *    encoded/displayed (graphics protocols don't clip), so the image never
 *    overflows the modeline above or the input line below;
 *  - repaint trigger: the painter is registered with painterRegistry and the
 *    sync-write combiner re-blits it inside the same DEC-2026 synchronized
 *    block as Ink's frame — flicker-free (validated by the #552 spikes);
 *  - band re-encode strategy is per-driver: cheap encoders (sixel — one shared
 *    quantization up front, then ~3-8ms/band) re-encode immediately for
 *    real-time scroll; any expensive encoder debounces to scroll-settle and
 *    reblits the cached payload each frame (lags a beat then snaps);
 *  - occlusion is checked LIVE in the painter (cheap), so opening a modal that
 *    covers the image hides it that very frame; an overlay that doesn't cover
 *    it (e.g. inline choices below the narrative) leaves it visible;
 *  - no graphics protocol → renders nothing (the full-res PNG still lives in
 *    the HTML transcript export).
 */
import React, { useEffect, useId, useLayoutEffect, useRef } from "react";
import { Box, useStdout, type DOMElement } from "ink";
import sharp from "sharp";
import type { GraphicsCapabilities } from "./capabilities.js";
import { pickProtocol, sixelPaletteSize } from "./capabilities.js";
import { selectDriver } from "./drivers/index.js";
import type { PreparedImage } from "./drivers/types.js";
import { registerPainter } from "./painterRegistry.js";
import { composePaint, type PaintBox } from "./paint.js";
import { visibleBand, bandPixels, isOccluded, type RowSpan } from "./geometry.js";
import { useOcclusionSpans } from "./occlusion.js";

/** Fallback cell size when the terminal didn't answer `\x1b[16t`. */
const FALLBACK_CELL = { width: 10, height: 20 };
/** Debounce for the expensive blit re-encode (scroll-settle). */
const ENCODE_DEBOUNCE_MS = 60;
/** DEC-2026 synchronized output — an empty BSU/ESU block forces an atomic repaint. */
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

interface CachedBand {
  payload: string;
  box: PaintBox;
  /** Band identity, to detect when a re-encode is actually needed. */
  srcTopRows: number;
  visRows: number;
}

export interface InlineImageProps {
  /** Absolute path to the on-disk image the engine wrote. */
  path: string;
  /** Reserved footprint in cells. */
  cols: number;
  rows: number;
  /** Absolute top row of the narrative viewport (where the ScrollView clips). */
  viewportTop: number;
  /** Narrative viewport height in rows. */
  viewportRows: number;
  /** Detected terminal graphics capabilities (null → render nothing inline). */
  graphicsCaps?: GraphicsCapabilities | null;
}

export function InlineImage({
  path, cols, rows, viewportTop, viewportRows, graphicsCaps,
}: InlineImageProps): React.ReactElement {
  const { stdout } = useStdout();
  const slotRef = useRef<DOMElement>(null);
  const getOcclusionSpans = useOcclusionSpans();
  const painterKey = useId();

  const protocol = graphicsCaps ? pickProtocol(graphicsCaps) : null;
  const driver = protocol ? selectDriver(protocol) : null;
  const paletteSize = graphicsCaps ? sixelPaletteSize(graphicsCaps) : 256;
  const cell = graphicsCaps?.cellPixels ?? FALLBACK_CELL;
  const widthPx = cols * cell.width;
  const heightPx = rows * cell.height;

  // --- live refs the painter reads (painter runs outside React, per frame) ---
  const posRef = useRef<{ slotTop: number; slotLeft: number; appHeight: number } | null>(null);
  const cachedRef = useRef<CachedBand | null>(null);
  const prevPaintedRef = useRef<PaintBox | null>(null);
  const viewportRef = useRef({ top: viewportTop, rows: viewportRows });
  viewportRef.current = { top: viewportTop, rows: viewportRows };
  const occlusionRef = useRef(getOcclusionSpans);
  occlusionRef.current = getOcclusionSpans;

  const preparedRef = useRef<PreparedImage | null>(null);
  const mountedRef = useRef(true);

  // Force an immediate repaint that doesn't depend on Ink emitting a frame.
  // Ink skips the stdout write when its render output is unchanged (our slot
  // Box never changes), so after an async encode we write an empty
  // synchronized block; the sync-write combiner splices the composite painter
  // (this image's escapes) inside it, painting atomically. Ink-initiated
  // frames are handled by the same combiner injection.
  const forceRepaint = () => { if (mountedRef.current) stdout.write(BSU + ESU); };

  // Measure slot position from the yoga tree (accounts for ScrollView's
  // marginTop:-scrollOffset, so this is the live on-screen row). slotLeft is
  // the absolute column the narrative content starts at — the side frame +
  // Layout's paddingLeft — so the out-of-band graphics land aligned with the
  // text instead of at terminal column 0 (which would paint the image's left
  // edge over the frame border).
  const measure = (): { slotTop: number; slotLeft: number; appHeight: number } | null => {
    const node = slotRef.current as unknown as { yogaNode?: YogaNode; parentNode?: ParentLike } | null;
    if (!node?.yogaNode) return null;
    let top = 0;
    let left = 0;
    let appHeight = 0;
    let cur: ParentLike | null = node as ParentLike;
    while (cur) {
      if (cur.yogaNode) {
        top += cur.yogaNode.getComputedTop();
        left += cur.yogaNode.getComputedLeft();
        appHeight = cur.yogaNode.getComputedHeight();
      }
      cur = cur.parentNode ?? null;
    }
    return { slotTop: top, slotLeft: left, appHeight };
  };

  // Decode + resize once, cache RGBA, prepare the driver.
  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    preparedRef.current = null;
    cachedRef.current = null;
    void (async () => {
      try {
        const { data } = await sharp(path)
          .resize(widthPx, heightPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (cancelled) return;
        preparedRef.current = driver.prepare(data, widthPx, heightPx, (s) => stdout.write(s), paletteSize, cell);
        scheduleEncode(); // first band
      } catch {
        // Missing/unreadable file: render nothing inline (export still has it).
      }
    })();
    return () => { cancelled = true; preparedRef.current?.dispose(); preparedRef.current = null; };
  }, [path, widthPx, heightPx, driver, paletteSize]);

  // Immediate (cheap encoders: sixel, kitty) or debounced (expensive encoders) band encode.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desiredBand = (): { box: PaintBox; srcTopRows: number; visRows: number } | null => {
    const pos = posRef.current;
    const vp = viewportRef.current;
    if (!pos) return null;
    const band = visibleBand(pos.slotTop, rows, vp.top, vp.rows);
    if (!band) return null;
    return {
      box: { row: band.visTop, col: pos.slotLeft, rows: band.visRows, cols },
      srcTopRows: band.srcTopRows,
      visRows: band.visRows,
    };
  };
  const encodeNow = () => {
    const prepared = preparedRef.current;
    const want = desiredBand();
    if (!prepared || !want) { cachedRef.current = null; forceRepaint(); return; }
    const { topPx, bandPx } = bandPixels(want.srcTopRows, want.visRows, cell.height);
    cachedRef.current = {
      payload: prepared.encodeBand(topPx, bandPx),
      box: want.box,
      srcTopRows: want.srcTopRows,
      visRows: want.visRows,
    };
    forceRepaint();
  };
  const scheduleEncode = () => {
    if (!driver) return;
    if (!driver.expensiveEncode) { encodeNow(); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(encodeNow, ENCODE_DEBOUNCE_MS);
  };

  // After every render (incl. scroll re-renders): re-measure, then either
  // re-encode (band pixels changed — clipped differently at an edge) or, when
  // a fully-visible image merely moved, cheaply re-blit the cached payload at
  // the new row. Without the reposition branch a scrolling, unclipped image
  // would stay frozen at its old position (and never un-hide after passing an
  // occluder), since its band identity is unchanged.
  useLayoutEffect(() => {
    posRef.current = measure();
    const want = desiredBand();
    const cur = cachedRef.current;
    const bandChanged = (!want && !!cur)
      || (!!want && (!cur || cur.srcTopRows !== want.srcTopRows || cur.visRows !== want.visRows));
    if (bandChanged) { scheduleEncode(); return; }
    if (want && cur && cur.box.row !== want.box.row) {
      cachedRef.current = { ...cur, box: want.box }; // same pixels, new position
      forceRepaint();
    }
  });

  // Register the per-frame painter once; it reads the live refs above.
  useEffect(() => {
    if (!driver) return;
    mountedRef.current = true;
    const off = registerPainter(painterKey, () => {
      const pos = posRef.current;
      const cached = cachedRef.current;
      const prev = prevPaintedRef.current;
      if (!pos) {
        // No live position yet: clear any prior placement, erase prior pixels.
        const clear = prev ? (preparedRef.current?.clear?.() ?? "") : "";
        prevPaintedRef.current = null;
        return clear + composePaint("", null, prev, 0);
      }
      let shown: PaintBox | null = cached?.box ?? null;
      // Live occlusion gate — hide the frame a covering modal opens.
      if (shown) {
        const span: RowSpan = { top: shown.row, rows: shown.rows };
        if (isOccluded(span, occlusionRef.current())) shown = null;
      }
      const payload = shown && cached ? cached.payload : "";
      // Placement protocols (kitty) leave a persistent placement a covering modal
      // won't overwrite — on the shown→hidden edge, explicitly delete it.
      const clear = prev && !shown ? (preparedRef.current?.clear?.() ?? "") : "";
      const out = clear + composePaint(payload, shown, prev, pos.appHeight);
      prevPaintedRef.current = shown;
      return out;
    });
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      off();
      // Erase whatever we last painted so no stale pixels linger. Wrap in a
      // synchronized block so the erase (and any sibling images the combiner
      // re-blits) lands atomically.
      const pos = posRef.current;
      if (prevPaintedRef.current && pos) {
        stdout.write(BSU + composePaint("", null, prevPaintedRef.current, pos.appHeight) + ESU);
        prevPaintedRef.current = null;
      }
    };
  }, [driver, painterKey]);

  // Reserve the footprint so layout is stable (text wraps around it) even when
  // the image paints out of band. Nothing renders here when there's no driver.
  return <Box ref={slotRef} width={cols} height={rows} />;
}

// Minimal structural types for the yoga parent-walk (Ink doesn't export these).
interface YogaNode { getComputedTop(): number; getComputedLeft(): number; getComputedHeight(): number }
interface ParentLike { yogaNode?: YogaNode; parentNode?: ParentLike | null }
