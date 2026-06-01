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
 *  - the painter is the single authority for position AND pixels, and it runs
 *    at the only correct moment: the sync-write combiner splices it into Ink's
 *    frame just before ESU, which Ink emits from onRender AFTER calculateLayout
 *    — so a fresh measure() there reads the slot row for the frame being drawn.
 *    Measuring in useLayoutEffect instead (React commit, BEFORE Ink lays out)
 *    lags one frame: invisible on a 1-row scroll, but a multi-row PgDn jump
 *    paints the image a full page behind the text and strands it there once the
 *    scroll settles. So there is no layout-effect repositioning and no changing
 *    prop to break the line's React.memo — the painter, which already runs every
 *    Ink frame, re-measures and re-clips itself;
 *  - band re-encode is cheap (sixel: one shared quantization up front, then
 *    ~3-8ms/band from frozen indices; iTerm2/kitty similar), so the painter
 *    re-encodes the clipped band in-frame whenever its identity changes and
 *    reuses the cached payload when it hasn't (a static image never re-encodes).
 *    A future expensive encoder would need a debounce reintroduced in the
 *    painter (re-blit the stale band until the encode settles);
 *  - modal occlusion is all-or-nothing: if an opaque modal's row-span overlaps
 *    the band at all, the painter hides the whole image and restores it when the
 *    modal closes. The hide/show is edge-triggered via useOcclusionChange (a
 *    dropped sixel frame must not strand the image over a modal — see
 *    occlusion.tsx); the repaint it schedules is DEFERRED to a microtask so it
 *    lands after the modal registered its span (no flash) and COALESCED. An
 *    overlay that registers no span (the inline ChoiceOverlay) leaves the image
 *    visible. (Partial *modal* cropping was tried and dropped.)
 *  - off-render-path repaints (async decode completion, occlusion edge) emit an
 *    empty DEC-2026 block (`requestRepaint`); Ink would otherwise dedupe (our
 *    slot Boxes are unchanged) and write nothing;
 *  - no graphics protocol → renders nothing (the full-res PNG still lives in
 *    the HTML transcript export).
 */
import React, { useEffect, useId, useRef, useState } from "react";
import { Box, useStdout, type DOMElement } from "ink";
import sharp from "sharp";
import type { GraphicsCapabilities } from "./capabilities.js";
import { pickProtocol, sixelPaletteSize } from "./capabilities.js";
import { selectDriver } from "./drivers/index.js";
import type { PreparedImage } from "./drivers/types.js";
import { registerPainter } from "./painterRegistry.js";
import { composePaint, type PaintBox } from "./paint.js";
import { visibleBand, bandPixels, fitImage, isOccluded } from "./geometry.js";
import { useOcclusionSpans, useOcclusionChange } from "./occlusion.js";

/** Fallback cell size when the terminal didn't answer `\x1b[16t`. */
const FALLBACK_CELL = { width: 10, height: 20 };
/** DEC-2026 synchronized output — an empty BSU/ESU block forces an atomic repaint. */
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

/**
 * The last encoded band. Position is NOT stored — the painter measures the slot
 * row fresh each frame (post-layout) and computes the box there. We keep only
 * the payload and its band identity so a static image (band unchanged frame to
 * frame) reuses the encode instead of re-encoding every frame.
 */
interface CachedBand {
  payload: string;
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

  // Repaint on the occlusion edge: when any modal opens or closes, re-derive
  // shown/hidden and blit. Without this the hide/show would depend on Ink
  // happening to emit (and not coalesce away) a frame for that exact render —
  // and slow sixel drops frames, so the edge gets missed (image hides on the
  // first modal open, then stays stranded over the modal on later opens). The
  // write is deferred + coalesced, so it lands after the modal's own occlusion
  // registration (no flash) and at most once per burst.
  useOcclusionChange(requestRepaint);

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
        cachedRef.current = null;        // force a fresh encode on the next paint
        requestRepaint();                // off the render path → ask for a paint; the painter encodes + blits
      } catch {
        // Missing/unreadable file: render nothing inline (export still has it).
      }
    })();
    return () => { cancelled = true; preparedRef.current?.img.dispose(); preparedRef.current = null; };
  }, [path, widthPx, heightPx, driver, paletteSize]);

  // Register the per-frame painter once. It is the SINGLE authority for both
  // position and pixels, and it runs at the right moment: the combiner splices
  // it into Ink's frame just before ESU, which is emitted from Ink's onRender
  // AFTER Ink's calculateLayout() — so a fresh measure() here reads the slot row
  // for the frame currently being drawn. (useLayoutEffect runs during React's
  // commit, BEFORE Ink lays out, so measuring there lags one frame: invisible on
  // a 1-row scroll, but a multi-row PgDn jump paints the image a full page behind
  // the text and — if the scroll settles — strands it there. Measuring in the
  // painter eliminates the lag entirely.)
  useEffect(() => {
    if (!driver) return;
    mountedRef.current = true;
    const off = registerPainter(painterKey, () => {
      const prep = preparedRef.current;
      const prev = prevPaintedRef.current;
      const occluders = occlusionRef.current();
      const pos = measure();
      posRef.current = pos;
      if (!pos || !prep) {
        const clear = prev ? (prep?.img.clear?.() ?? "") : "";
        prevPaintedRef.current = null;
        return clear + composePaint("", null, prev, pos?.appHeight ?? 0, occluders);
      }
      // Clip the footprint to the viewport at the fresh row.
      const vp = viewportRef.current;
      const band = visibleBand(pos.slotTop, prep.rows, vp.top, vp.rows);
      let shown: PaintBox | null = null;
      let payload = "";
      if (band) {
        const cached = cachedRef.current;
        if (cached && cached.srcTopRows === band.srcTopRows && cached.visRows === band.visRows) {
          payload = cached.payload; // band identity unchanged (static image) → reuse, no re-encode
        } else {
          // Band changed (scrolled / clipped differently): re-encode now. All
          // current drivers are cheap (~1-8ms/band from a cached raster), so
          // this is real-time. A future expensive encoder would need a debounce
          // reintroduced here (re-blit the stale band meanwhile).
          const { topPx, bandPx } = bandPixels(band.srcTopRows, band.visRows, cell.height);
          payload = prep.img.encodeBand(topPx, bandPx);
          cachedRef.current = { payload, srcTopRows: band.srcTopRows, visRows: band.visRows };
        }
        shown = { row: band.visTop, col: pos.slotLeft, rows: band.visRows, cols: prep.cols };
      }
      // All-or-nothing modal occlusion: if any open modal's row-span overlaps the
      // band, hide the whole image (useOcclusionChange repaints on that edge).
      if (shown && isOccluded({ top: shown.row, rows: shown.rows }, occluders)) { shown = null; payload = ""; }
      // Placement protocols (kitty) leave a persistent placement a covering modal
      // won't overwrite — on the shown→hidden edge, explicitly delete it.
      const clear = prev && !shown ? (prep.img.clear?.() ?? "") : "";
      // Pass occluders so vacated-row erase never blanks a row a modal owns.
      const out = clear + composePaint(payload, shown, prev, pos.appHeight, occluders);
      prevPaintedRef.current = shown;
      return out;
    });
    return () => {
      mountedRef.current = false;
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
