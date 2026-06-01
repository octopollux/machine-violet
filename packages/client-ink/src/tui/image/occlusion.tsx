/**
 * Occlusion registry for inline images.
 *
 * Out-of-band graphics have no z-ordering against Ink's text grid, so an open
 * modal can't sit "over" an image — we must blank the image while an overlay
 * actually covers its rows. But an overlay that does NOT cover the image (e.g.
 * the inline ChoiceOverlay in the player pane, below the narrative) should
 * leave it visible.
 *
 * Modals report their absolute row-span here via `useRegisterOcclusion`; the
 * inline-image painter reads the live set via `useOcclusionSpans` and hides
 * only when its band overlaps one. Registration uses `useLayoutEffect` so a
 * modal's span is present in the very frame it first renders (Ink writes the
 * frame after commit, after layout effects), preventing a one-frame flash of
 * the image over/under the modal.
 *
 * Nearly every modal funnels through two components (CenteredModal, OverlayPane)
 * that already compute their absolute marginTop + height, so registration lives
 * at just those two call sites — no per-modal geometry duplication.
 */
import React, { createContext, useContext, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { RowSpan } from "./geometry.js";

interface OcclusionRegistry {
  register: (id: string, span: RowSpan) => void;
  unregister: (id: string) => void;
  /** Live snapshot of all registered spans (read each frame by the painter). */
  getSpans: () => RowSpan[];
}

const OcclusionContext = createContext<OcclusionRegistry | null>(null);

export function OcclusionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const mapRef = useRef<Map<string, RowSpan>>(new Map());
  const registry = useMemo<OcclusionRegistry>(() => ({
    register: (id, span) => { mapRef.current.set(id, span); },
    unregister: (id) => { mapRef.current.delete(id); },
    getSpans: () => Array.from(mapRef.current.values()),
  }), []);
  return <OcclusionContext.Provider value={registry}>{children}</OcclusionContext.Provider>;
}

/**
 * Register an occluding row-span for the lifetime this is mounted with a
 * non-null span. `top`/`rows` are absolute terminal rows. Pass null to
 * register nothing (e.g. while the modal is measuring).
 */
export function useRegisterOcclusion(span: RowSpan | null): void {
  const registry = useContext(OcclusionContext);
  const id = useId();
  const top = span?.top ?? -1;
  const rows = span?.rows ?? 0;
  useLayoutEffect(() => {
    if (!registry || rows <= 0) return;
    registry.register(id, { top, rows });
    return () => registry.unregister(id);
  }, [registry, id, top, rows]);
}

/**
 * Returns a stable getter for the current occlusion spans. The inline-image
 * painter calls it each frame. Returns `() => []` when outside a provider.
 */
export function useOcclusionSpans(): () => RowSpan[] {
  const registry = useContext(OcclusionContext);
  return useMemo(() => registry?.getSpans ?? (() => []), [registry]);
}
