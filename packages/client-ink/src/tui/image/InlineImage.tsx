/**
 * MV-owned inline image renderer (issue #552). Replaces ink-picture's <Image>.
 *
 * Composes correctly with the live, scrolling, layered TUI:
 *  - sizing: the parent passes BOUNDS (max cols, max rows). This component reads
 *    the image's true aspect (sharp metadata, header-only — cheap) and reserves
 *    EXACTLY the scaled footprint — landscapes fill width, portraits fill height
 *    up to the row cap. No letterbox bars, no double padding (see geometry.ts
 *    `fitImage`). One reflow when metadata lands.
 *  - decode + resize ONCE (sharp), cache raw RGBA (avoids the re-decode CPU
 *    meltdown);
 *  - vertical band crop: only the rows inside the narrative viewport are
 *    encoded/displayed (graphics protocols don't clip), so the image never
 *    overflows the modeline above or the input line below — this partial crop
 *    is for the viewport's top/bottom edges only;
 *  - modal occlusion is all-or-nothing: if an opaque modal's row-span overlaps
 *    the band at all, the painter hides the whole image that frame and restores
 *    it (cached band intact) when the modal closes. Modal open/close each emit
 *    an Ink frame, so the live painter check suffices — no re-encode, no store
 *    subscription. (Partial *modal* cropping was tried and dropped: interior
 *    splits and re-encode timing weren't worth the complexity.) An overlay that
 *    doesn't register a span (the inline ChoiceOverlay) leaves the image visible.
 *  - repaint trigger: the painter is registered with painterRegistry and the
 *    sync-write combiner re-blits it inside the same DEC-2026 synchronized
 *    block as Ink's frame — flicker-free (validated by the #552 spikes). Ink
 *    dedupes/throttles frames and our slot Boxes don't change when only the
 *    out-of-band pixels do, so an async band encode emits its own empty
 *    synchronized block (`requestRepaint`), DEFERRED to a microtask so it lands
 *    after every layout effect in the commit (modal occlusion registration
 *    included → no flash) and COALESCED to one write per checkpoint;
 *  - band re-encode strategy is per-driver: cheap encoders (sixel — one shared
 *    quantization up front, then ~3-8ms/band) re-encode immediately for
 *    real-time scroll; any expensive encoder debounces to scroll-settle and
 *    reblits the cached payload each frame (lags a beat then snaps);
 *  - no graphics protocol → renders nothing (the full-res PNG still lives in
 *    the HTML transcript export).
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Box, useStdout, type DOMElement } from "ink";
import sharp from "sharp";
import type { GraphicsCapabilities } from "./capabilities.js";
import { pickProtocol, sixelPaletteSize } from "./capabilities.js";
import { selectDriver } from "./drivers/index.js";
import type { PreparedImage } from "./drivers/types.js";
import { registerPainter } from "./painterRegistry.js";
import { composePaint, type PaintBox } from "./paint.js";
import { visibleBand, bandPixels, fitImage, isOccluded } from "./geometry.js";
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
  /** Max footprint in cells — the image fits its true aspect inside this box. */
  maxCols: number;
  maxRows: number;
  /** Absolute top row of the narrative viewport (where the ScrollView clips). */
  viewportTop: number;
  /** Narrative viewport height in rows. */
  viewportRows: number;
  /** Detected terminal graphics capabilities (null → render nothing inline). */
  graphicsCaps?: GraphicsCapabilities | null;
}

export function InlineImage({
  path, maxCols, maxRows, viewportTop, viewportRows, graphicsCaps,
}: InlineImageProps): React.ReactElement {
  const { stdout } = useStdout();
  const slotRef = useRef<DOMElement>(null);
  const getOcclusionSpans = useOcclusionSpans();
  const painterKey = useId();

  const protocol = graphicsCaps ? pickProtocol(graphicsCaps) : null;
  const driver = protocol ? selectDriver(protocol) : null;
  const paletteSize = graphicsCaps ? sixelPaletteSize(graphicsCaps) : 256;
  const cell = graphicsCaps?.cellPixels ?? FALLBACK_CELL;

  // True image dimensions (header-only read). Null until the metadata lands; we
  // reserve a wide default in the meantime, so non-portrait images don't reflow
  // and portraits reflow exactly once.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const { cols, rows } = natural
    ? fitImage(natural.width, natural.height, maxCols, maxRows, cell)
    : { cols: maxCols, rows: Math.max(1, Math.min(maxRows, Math.round((maxCols * 9) / 32))) };

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

  // The prepared raster is the SINGLE SOURCE OF TRUTH for band geometry — its
  // baked-in cols/rows are what the band is computed against, never the live
  // footprint. The footprint reflows synchronously when metadata lands, but the
  // raster is re-decoded asynchronously (passive effect); if the band were sized
  // off the live footprint it could ask for more rows than the current raster
  // holds, and sixel's `subarray` would come up short ("wrong geometry of
  // data"). Sizing off the raster lags the reflow by one decode — cosmetically
  // invisible — but can never overflow it.
  const preparedRef = useRef<{ img: PreparedImage; cols: number; rows: number } | null>(null);
  const mountedRef = useRef(true);

  // Read the image's intrinsic size once so we can reserve its true aspect.
  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    void (async () => {
      try {
        const meta = await sharp(path).metadata();
        if (cancelled || !meta.width || !meta.height) return;
        setNatural({ width: meta.width, height: meta.height });
      } catch { /* unreadable: keep the default footprint, decode will no-op */ }
    })();
    return () => { cancelled = true; };
  }, [path, driver]);

  // Repaint that doesn't depend on Ink emitting a frame. Ink DEDUPES identical
  // frames (ink.js `renderInteractiveFrame`: it only writes when
  // `output !== lastOutput`) and throttles the writes it does make; our slot
  // Boxes don't change when only the out-of-band pixels change, so after an
  // async band encode Ink would write nothing and the image would freeze. We
  // emit an empty synchronized block and let the sync-write combiner splice the
  // composite painter inside it, painting atomically.
  //
  // The write is DEFERRED to a microtask and COALESCED (at most one per
  // checkpoint):
  //  - deferral lands the paint AFTER every layout effect in this commit has
  //    run, so a modal that registers its occlusion span in its own layout
  //    effect is already visible to the painter — no one-frame flash of the
  //    image over the modal. (Sibling layout effects run in JSX order and
  //    <Layout> precedes the modals in PlayingPhase, so a synchronous write
  //    here would paint before the modal registered.)
  //  - coalescing caps image writes at one per microtask checkpoint, so a burst
  //    of requests (rapid scroll) can't issue more out-of-band writes than
  //    there are frames.
  const repaintScheduledRef = useRef(false);
  const requestRepaint = () => {
    if (!mountedRef.current || repaintScheduledRef.current) return;
    repaintScheduledRef.current = true;
    queueMicrotask(() => {
      repaintScheduledRef.current = false;
      if (mountedRef.current) stdout.write(BSU + ESU);
    });
  };

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

  // Decode + resize once, cache RGBA, prepare the driver. Re-runs if the
  // footprint changes (the metadata reflow) so the raster matches the cells.
  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    preparedRef.current?.img.dispose();
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
        const img = driver.prepare(data, widthPx, heightPx, (s) => stdout.write(s), paletteSize, cell);
        preparedRef.current = { img, cols, rows };
        scheduleEncode(); // first band
      } catch {
        // Missing/unreadable file: render nothing inline (export still has it).
      }
    })();
    return () => { cancelled = true; preparedRef.current?.img.dispose(); preparedRef.current = null; };
  }, [path, widthPx, heightPx, driver, paletteSize]);

  // Immediate (cheap encoders: sixel, kitty) or debounced (expensive encoders) band encode.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The band to display now: the image's footprint clipped to the narrative
  // viewport (top/bottom edges). Modal occlusion is NOT applied here — it's an
  // all-or-nothing live hide in the painter, so the cached band survives intact
  // while a modal covers it and reappears the moment it closes (no re-encode).
  const desiredBand = (): { box: PaintBox; srcTopRows: number; visRows: number } | null => {
    const pos = posRef.current;
    const vp = viewportRef.current;
    const prep = preparedRef.current;
    if (!pos || !prep) return null;
    const band = visibleBand(pos.slotTop, prep.rows, vp.top, vp.rows);
    if (!band) return null;
    return {
      box: { row: band.visTop, col: pos.slotLeft, rows: band.visRows, cols: prep.cols },
      srcTopRows: band.srcTopRows,
      visRows: band.visRows,
    };
  };
  const encodeNow = () => {
    const prepared = preparedRef.current;
    const want = desiredBand();
    if (!prepared || !want) { cachedRef.current = null; requestRepaint(); return; }
    const { topPx, bandPx } = bandPixels(want.srcTopRows, want.visRows, cell.height);
    cachedRef.current = {
      payload: prepared.img.encodeBand(topPx, bandPx),
      box: want.box,
      srcTopRows: want.srcTopRows,
      visRows: want.visRows,
    };
    requestRepaint();
  };
  const scheduleEncode = () => {
    if (!driver) return;
    if (!driver.expensiveEncode) { encodeNow(); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(encodeNow, ENCODE_DEBOUNCE_MS);
  };

  // After every render (scroll, metadata reflow, modal open/close): re-measure,
  // then either re-encode (band pixels changed — clipped/occluded differently)
  // or, when a fully-visible image merely moved, cheaply re-blit the cached
  // payload at the new row. Without the reposition branch a scrolling, unclipped
  // image would stay frozen at its old position (and never un-hide after passing
  // an occluder), since its band identity is unchanged.
  useLayoutEffect(() => {
    posRef.current = measure();
    const want = desiredBand();
    const cur = cachedRef.current;
    const bandChanged = (!want && !!cur)
      || (!!want && (!cur || cur.srcTopRows !== want.srcTopRows || cur.visRows !== want.visRows));
    if (bandChanged) { scheduleEncode(); return; }
    if (want && cur && cur.box.row !== want.box.row) {
      cachedRef.current = { ...cur, box: want.box }; // same pixels, new position
      requestRepaint();
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
      const occluders = occlusionRef.current();
      if (!pos) {
        // No live position yet: clear any prior placement, erase prior pixels.
        const clear = prev ? (preparedRef.current?.img.clear?.() ?? "") : "";
        prevPaintedRef.current = null;
        return clear + composePaint("", null, prev, 0, occluders);
      }
      let shown: PaintBox | null = cached?.box ?? null;
      // Live occlusion gate (all-or-nothing): if any open modal's row-span
      // overlaps the band at all, hide the whole image. Modal open/close each
      // emit an Ink frame, so this re-evaluates the same frame the modal appears
      // — no re-encode, and the cached band reappears intact when it closes.
      if (shown && isOccluded({ top: shown.row, rows: shown.rows }, occluders)) shown = null;
      const payload = shown && cached ? cached.payload : "";
      // Placement protocols (kitty) leave a persistent placement a covering modal
      // won't overwrite — on the shown→hidden edge, explicitly delete it.
      const clear = prev && !shown ? (preparedRef.current?.img.clear?.() ?? "") : "";
      // Pass occluders so vacated-row erase never blanks a row a modal owns.
      const out = clear + composePaint(payload, shown, prev, pos.appHeight, occluders);
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
        stdout.write(BSU + composePaint("", null, prevPaintedRef.current, pos.appHeight, occlusionRef.current()) + ESU);
        prevPaintedRef.current = null;
      }
    };
  }, [driver, painterKey]);

  // Reserve the footprint so layout is stable (text wraps around it) even when
  // the image paints out of band. Nothing renders here when there's no driver.
  // The slot is centered within the full bounds, so when an image can't fill
  // width (a height-capped portrait) the unavoidable slack splits into symmetric
  // side pillars instead of piling up on the right; for a width-filling image
  // (cols === maxCols) the wrapper is a no-op and slotLeft stays frame-aligned.
  // The painter reads slotLeft from the yoga tree, so it tracks the centering
  // for free — no paint-side offset needed.
  return (
    <Box width={maxCols} justifyContent="center">
      <Box ref={slotRef} width={cols} height={rows} />
    </Box>
  );
}

// Minimal structural types for the yoga parent-walk (Ink doesn't export these).
interface YogaNode { getComputedTop(): number; getComputedLeft(): number; getComputedHeight(): number }
interface ParentLike { yogaNode?: YogaNode; parentNode?: ParentLike | null }
