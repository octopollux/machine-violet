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
 *    overflows the modeline above or the input line below;
 *  - occlusion is part of that same band: rows an opaque modal covers are
 *    subtracted from the band (geometry.ts `subtractOcclusion`), so the image
 *    keeps showing the part the modal leaves free instead of vanishing whole.
 *    A modal opening/closing bumps the occlusion store (occlusion.tsx), which
 *    re-renders this component and re-encodes the trimmed band; the painter also
 *    hides live (same frame) if the cached band is stale vs current occluders.
 *  - repaint trigger: the painter is registered with painterRegistry and the
 *    sync-write combiner re-blits it inside the same DEC-2026 synchronized
 *    block as Ink's frame — flicker-free (validated by the #552 spikes);
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
import {
  visibleBand, subtractOcclusion, bandPixels, fitImage, isOccluded,
} from "./geometry.js";
import { useOcclusionSpans, useOcclusionVersion } from "./occlusion.js";

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
  // Re-render (→ re-measure → re-encode the occlusion-trimmed band) whenever a
  // modal opens, closes, or moves. Without this the band would only recompute
  // on scroll, so a modal opening over part of an image wouldn't crop it.
  useOcclusionVersion();
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

  // Force a repaint that doesn't depend on Ink emitting a frame. Ink skips the
  // stdout write when its render output is unchanged (our slot Box only changes
  // on the one metadata reflow), so after an async encode we write an empty
  // synchronized block; the sync-write combiner splices the composite painter
  // (this image's escapes) inside it, painting atomically.
  //
  // Coalesced onto a microtask, and this matters for correctness, not just
  // batching: a modal opening re-encodes this image, but the modal registers
  // its occlusion span in a sibling layout effect that runs AFTER ours (JSX
  // order). A synchronous write here would paint the full, un-trimmed band
  // against not-yet-registered occluders — straight over the modal — and only a
  // second write would correct it (the visible "image redraws on top of the
  // modal" flash). Deferring to a microtask lets every synchronous layout effect
  // (the modal's registration) and the reactive re-encode settle first, so the
  // single flushed write paints the already-trimmed band.
  const repaintPendingRef = useRef(false);
  const forceRepaint = () => {
    if (!mountedRef.current || repaintPendingRef.current) return;
    repaintPendingRef.current = true;
    queueMicrotask(() => {
      repaintPendingRef.current = false;
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
  // The band to display now: the image's footprint clipped to the viewport,
  // then trimmed by the rows any open modal covers.
  const desiredBand = (): { box: PaintBox; srcTopRows: number; visRows: number } | null => {
    const pos = posRef.current;
    const vp = viewportRef.current;
    const prep = preparedRef.current;
    if (!pos || !prep) return null;
    const clipped = visibleBand(pos.slotTop, prep.rows, vp.top, vp.rows);
    if (!clipped) return null;
    const band = subtractOcclusion(clipped, occlusionRef.current());
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
    if (!prepared || !want) { cachedRef.current = null; forceRepaint(); return; }
    const { topPx, bandPx } = bandPixels(want.srcTopRows, want.visRows, cell.height);
    cachedRef.current = {
      payload: prepared.img.encodeBand(topPx, bandPx),
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
      const occluders = occlusionRef.current();
      if (!pos) {
        // No live position yet: clear any prior placement, erase prior pixels.
        const clear = prev ? (preparedRef.current?.img.clear?.() ?? "") : "";
        prevPaintedRef.current = null;
        return clear + composePaint("", null, prev, 0, occluders);
      }
      let shown: PaintBox | null = cached?.box ?? null;
      // Live occlusion gate: the cached band was encoded to avoid occluders, so
      // if it now overlaps one, occlusion changed since the last encode (modal
      // just opened) and the band is stale — hide this frame; the reactive
      // re-encode lands the trimmed band on the next.
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
