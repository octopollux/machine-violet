/**
 * Defensive coercion of the model's `generate_image` tool args into
 * valid {@link ImageEffort} / {@link ImageAspect} values.
 *
 * Why coerce instead of trust:
 *   - JSON tool arg schemas aren't enforced server-side. A model can
 *     pass `effort: "fast"` or `aspect: "PORTRAIT"` and the SDK will
 *     happily pass it through. We catch that here so the provider's
 *     mapping table doesn't get an unmapped key.
 *   - The DM dispatcher passes its own fallback (quality/square) rather than
 *     baking it in here. (The setup/chargen dispatcher doesn't coerce at all —
 *     it pins the single canonical config, a standard-effort landscape
 *     reference sheet, since the model has no effort/aspect choice there.)
 */
import type { ImageEffort, ImageAspect } from "./types.js";

const EFFORTS = new Set<ImageEffort>(["draft", "standard", "quality", "showcase"]);
const ASPECTS = new Set<ImageAspect>(["portrait", "landscape", "square"]);

export function normalizeImageEffort(raw: unknown, fallback: ImageEffort = "standard"): ImageEffort {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  return EFFORTS.has(s as ImageEffort) ? (s as ImageEffort) : fallback;
}

export function normalizeImageAspect(raw: unknown, fallback: ImageAspect = "square"): ImageAspect {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  return ASPECTS.has(s as ImageAspect) ? (s as ImageAspect) : fallback;
}
