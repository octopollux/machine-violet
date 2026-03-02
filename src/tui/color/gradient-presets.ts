/**
 * Built-in gradient presets for per-character border coloring.
 * Registered via side-effect import (same pattern as presets.ts).
 */

import { easeInOut, linearRamp } from "./curves.js";
import type { GradientPreset } from "./gradient.js";
import { registerGradient } from "./gradient.js";

/** Darkens toward edges — dramatic vignette effect. */
export const vignette: GradientPreset = {
  name: "vignette",
  lightness: { curve: easeInOut(0, 1), range: [0, -0.3] },
  chroma: { curve: linearRamp(0, 1), range: [0, -0.06] },
};

/** Center-bright sheen — smooth ∩-shaped glow cooperating with mirrorT. */
export const shimmer: GradientPreset = {
  name: "shimmer",
  lightness: { curve: easeInOut(1, 0), range: [-0.15, 0.15] },
  chroma: { curve: easeInOut(1, 0), range: [-0.02, 0.02] },
};

/** Hue rotates from center outward with noticeable darkening. */
export const hueShift: GradientPreset = {
  name: "hueShift",
  hue: { curve: linearRamp(0, 1), range: [0, 30] },
  lightness: { curve: easeInOut(0, 1), range: [0, -0.2] },
};

// Register all gradient presets
registerGradient(vignette);
registerGradient(shimmer);
registerGradient(hueShift);
