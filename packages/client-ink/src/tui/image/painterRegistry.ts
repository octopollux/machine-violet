/**
 * Module-level registry of inline-image "painters".
 *
 * The repaint trigger for graphics protocols that get clobbered by Ink's
 * per-frame full redraw (sixel, iTerm2) is: re-emit the image escapes inside
 * the *same* DEC-2026 synchronized-output block as Ink's frame, so the
 * terminal never displays the blanked intermediate state. The sync-write
 * combiner (../hooks/syncWriteCombiner.ts) owns that block; it calls
 * `compositePainters()` and splices the result in just before `ESU`.
 *
 * Each visible inline image registers a painter keyed by its narrative line
 * index. A painter is a pure read of refs the image component keeps current
 * (cached band escapes + position); it returns the escape string to blit now,
 * or "" when the image is off-screen / occluded / not yet encoded.
 *
 * This lives outside React because the combiner runs at the stdout layer,
 * below the React tree. The component manages register/unregister via effects.
 */

export type Painter = () => string;

const painters = new Map<string, Painter>();

/**
 * Whether Ink renders incrementally (rewriting only the lines whose text
 * changed) rather than fully erasing + redrawing every frame.
 *
 * This gates the inline-image painter's steady-state skip: with incremental
 * rendering on, an unrelated re-render (e.g. the once-a-second activity
 * counter) leaves the image's unchanged slot rows alone, so the painter can
 * emit nothing instead of re-blitting its whole payload. Under the STANDARD
 * renderer every frame clobbers those rows, so the painter must re-blit
 * unconditionally — skipping there would make the image vanish.
 *
 * Default `false` (the conservative, always-correct behavior). start-client.ts
 * sets it to match the `incrementalRendering` option it passes to `render()`,
 * keeping the two in lock-step — see the painter in InlineImage.tsx.
 */
let incrementalRendering = false;

export function setIncrementalRendering(on: boolean): void {
  incrementalRendering = on;
}

export function isIncrementalRendering(): boolean {
  return incrementalRendering;
}

/** Register a painter; returns an unregister function. Re-registering a key replaces it. */
export function registerPainter(key: string, paint: Painter): () => void {
  painters.set(key, paint);
  return () => {
    // Only delete if it's still the same painter (guards against a remount
    // having already replaced this key).
    if (painters.get(key) === paint) painters.delete(key);
  };
}

/** Concatenate every painter's current output. Empty contributions are skipped. */
export function compositePainters(): string {
  if (painters.size === 0) return "";
  let out = "";
  for (const paint of painters.values()) {
    const s = paint();
    if (s) out += s;
  }
  return out;
}

/** Number of registered painters (debug/tests). */
export function painterCount(): number {
  return painters.size;
}

/** Remove all painters. Tests only. */
export function clearPainters(): void {
  painters.clear();
}
