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
