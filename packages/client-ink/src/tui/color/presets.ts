/**
 * Built-in color presets for theme swatch generation.
 * Each preset is a factory that takes a base hex color and returns SwatchParams.
 */

import { sinePulse, linearRamp, easeInOut, bell, constant } from "./curves.js";
import { type SwatchParams, type PresetFactory, registerPreset } from "./swatch.js";
import { hexToOklch } from "./oklch.js";

function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

// --- Foliage: warm earth tones, narrow hue, gentle lightness ---
const foliage: PresetFactory = {
  name: "foliage",
  build(baseHex: string): SwatchParams {
    const { H } = hexToOklch(baseHex);
    return {
      arc: { hStart: normalizeHue(H - 25), hEnd: normalizeHue(H + 25), direction: "cw" },
      steps: 8,
      chromaCurve: sinePulse(0.5, 0.3),
      lightnessCurve: easeInOut(0.3, 0.75),
      chromaRange: [0.03, 0.12],
      lightnessRange: [0.25, 0.80],
    };
  },
};

// --- Cyberpunk: wide neon hue sweep, high chroma, dark base ---
const cyberpunk: PresetFactory = {
  name: "cyberpunk",
  build(baseHex: string): SwatchParams {
    const { H } = hexToOklch(baseHex);
    return {
      arc: { hStart: normalizeHue(H - 60), hEnd: normalizeHue(H + 60), direction: "cw" },
      steps: 10,
      chromaCurve: bell(0.5, 0.3),
      lightnessCurve: linearRamp(0.2, 0.9),
      chromaRange: [0.05, 0.20],
      lightnessRange: [0.15, 0.90],
    };
  },
};

// --- Ember: tight warm arc, chroma peaks in center, lightness dips ---
const ember: PresetFactory = {
  name: "ember",
  build(baseHex: string): SwatchParams {
    const { H } = hexToOklch(baseHex);
    return {
      arc: { hStart: normalizeHue(H - 15), hEnd: normalizeHue(H + 30), direction: "cw" },
      steps: 8,
      chromaCurve: bell(0.4, 0.25),
      lightnessCurve: sinePulse(0.45, 0.25),
      chromaRange: [0.04, 0.18],
      lightnessRange: [0.20, 0.75],
    };
  },
};

// --- Ethereal: wide pastel sweep, low chroma, high lightness ---
const ethereal: PresetFactory = {
  name: "ethereal",
  build(baseHex: string): SwatchParams {
    const { H } = hexToOklch(baseHex);
    return {
      arc: { hStart: normalizeHue(H - 45), hEnd: normalizeHue(H + 45), direction: "cw" },
      steps: 8,
      chromaCurve: constant(0.4),
      lightnessCurve: easeInOut(0.6, 0.9),
      chromaRange: [0.02, 0.08],
      lightnessRange: [0.60, 0.92],
    };
  },
};

// Register all presets
registerPreset(foliage);
registerPreset(cyberpunk);
registerPreset(ember);
registerPreset(ethereal);

export { foliage, cyberpunk, ember, ethereal };
