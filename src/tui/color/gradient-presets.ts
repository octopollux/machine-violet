/**
 * Built-in gradient presets for per-character border coloring.
 * Registered via side-effect import (same pattern as presets.ts).
 */

import { easeInOut, linearRamp, sinePulse } from "./curves.js";
import type { GradientPreset } from "./gradient.js";
import { registerGradient } from "./gradient.js";

/** Darkens toward edges — subtle vignette effect. */
export const vignette: GradientPreset = {
  name: "vignette",
  lightness: { curve: easeInOut(0, 1), range: [0, -0.15] },
  chroma: { curve: linearRamp(0, 1), range: [0, -0.03] },
};

/** Sinusoidal lightness sheen — subtle shimmer across the border. */
export const shimmer: GradientPreset = {
  name: "shimmer",
  lightness: { curve: sinePulse(0, 1), range: [-0.08, 0.08] },
};

/** Hue rotates from center outward with slight darkening. */
export const hueShift: GradientPreset = {
  name: "hueShift",
  hue: { curve: linearRamp(0, 1), range: [0, 20] },
  lightness: { curve: easeInOut(0, 1), range: [0, -0.08] },
};

// Register all gradient presets
registerGradient(vignette);
registerGradient(shimmer);
registerGradient(hueShift);
