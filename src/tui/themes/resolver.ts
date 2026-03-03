/**
 * Theme resolver — merges a ThemeDefinition with variant overrides
 * and generates the final swatch + color map.
 */

import type { Color, GradientPreset } from "../color/index.js";
import { fromPreset, generateArc, simpleArc, getGradient } from "../color/index.js";
// Side-effect: ensure presets and gradient presets are registered
import "../color/presets.js";
import "../color/gradient-presets.js";

import type {
  ThemeDefinition,
  ResolvedTheme,
  StyleVariant,
  ThemeColorMap,
  SwatchConfig,
  ThemeAsset,
  PlayerPaneFrame,
} from "./types.js";
import { loadBuiltinTheme, loadBuiltinPlayerFrame } from "./loader.js";

/**
 * Resolve a ThemeDefinition into a fully renderable ResolvedTheme.
 *
 * @param definition - The theme definition to resolve
 * @param variant - The active style variant
 * @param keyColorHex - Base color hex for swatch generation (defaults to "#8888aa")
 */
export function resolveTheme(
  definition: ThemeDefinition,
  variant: StyleVariant,
  keyColorHex?: string,
): ResolvedTheme {
  const keyColor = keyColorHex ?? "#8888aa";

  // Load the assets
  const asset: ThemeAsset = loadBuiltinTheme(definition.assetName);
  const playerPaneFrame: PlayerPaneFrame = loadBuiltinPlayerFrame(
    definition.playerFrameName ?? "default",
  );

  // Merge variant overrides
  const variantOverride = definition.variants?.[variant];
  const swatchConfig: SwatchConfig = {
    ...definition.swatchConfig,
    ...variantOverride?.swatchConfig,
  };
  const colorMap: ThemeColorMap = {
    ...definition.colorMap,
    ...variantOverride?.colorMap,
  };

  // Generate swatch
  const SAFE_DEFAULT_HEX = "#8888aa";
  let swatch: Color[];
  try {
    swatch = fromPreset(swatchConfig.preset, keyColor);
  } catch {
    try {
      // Fallback to simple arc if preset not found
      const params = simpleArc(keyColor);
      swatch = generateArc(params);
    } catch {
      // Fallback to safe default if keyColor is invalid hex
      const params = simpleArc(SAFE_DEFAULT_HEX);
      swatch = generateArc(params);
    }
  }

  // Resolve gradient preset
  // Variant override: explicit null disables gradient; explicit config overrides base
  let gradient: GradientPreset | undefined;
  const variantGradient = variantOverride?.gradient;
  if (variantGradient === null) {
    gradient = undefined; // explicitly disabled
  } else if (variantGradient) {
    gradient = getGradient(variantGradient.preset);
  } else if (definition.gradient) {
    gradient = getGradient(definition.gradient.preset);
  }

  return {
    asset,
    playerPaneFrame,
    swatch,
    colorMap,
    variant,
    keyColor,
    gradient,
  };
}
