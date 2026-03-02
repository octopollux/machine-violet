export type { OklchColor, RgbColor } from "./oklch.js";
export { oklchToHex, hexToOklch, hexToRgb, gamutClamp } from "./oklch.js";

export type { CurveFunction } from "./curves.js";
export { constant, linearRamp, sinePulse, easeInOut, bell, compose } from "./curves.js";

export type { HueArc, SwatchParams, Color, HarmonyType, PresetFactory } from "./swatch.js";
export {
  generateArc,
  generateAnchors,
  fromPreset,
  listPresets,
  getPreset,
  registerPreset,
  simpleArc,
} from "./swatch.js";

export type { ChannelModulation, GradientPreset, ColorizeSegment } from "./gradient.js";
export {
  mirrorT,
  applyGradient,
  colorizeSegments,
  registerGradient,
  getGradient,
  listGradients,
} from "./gradient.js";

// Side-effect imports: register built-in presets and gradient presets
import "./presets.js";
import "./gradient-presets.js";
export { foliage, cyberpunk, ember, ethereal } from "./presets.js";
export { vignette, shimmer, hueShift } from "./gradient-presets.js";
