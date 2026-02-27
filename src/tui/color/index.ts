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

// Side-effect import: registers built-in presets
import "./presets.js";
export { foliage, cyberpunk, ember, ethereal } from "./presets.js";
