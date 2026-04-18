/**
 * Browser-side theme resolver.
 * Accepts pre-parsed ThemeAsset + PlayerPaneFrame (no filesystem access)
 * and produces a ResolvedTheme ready for rendering — mirrors the
 * game-side resolver without importing the Node loader.
 */

import type {
  ResolvedTheme,
  ThemeDefinition,
  ThemeAsset,
  PlayerPaneFrame,
  StyleVariant,
  SwatchConfig,
  ThemeColorMap,
} from "@engine-src/tui/themes/types.js";
import {
  generateHarmonySwatch,
  generateArc,
  simpleArc,
  getGradient,
  type Color,
  type GradientPreset,
} from "@engine-src/tui/color/index.js";

const SAFE_DEFAULT_HEX = "#8888aa";

export function resolveThemeWithAssets(
  definition: ThemeDefinition,
  asset: ThemeAsset,
  playerPaneFrame: PlayerPaneFrame,
  variant: StyleVariant,
  keyColorHex?: string,
): ResolvedTheme {
  const keyColor = keyColorHex && keyColorHex.trim() !== "" ? keyColorHex : SAFE_DEFAULT_HEX;

  const variantOverride = definition.variants?.[variant];
  const swatchConfig: SwatchConfig = {
    ...definition.swatchConfig,
    ...variantOverride?.swatchConfig,
  };
  const colorMap: ThemeColorMap = {
    ...definition.colorMap,
    ...variantOverride?.colorMap,
  };

  let harmonySwatch: Color[][];
  try {
    harmonySwatch = generateHarmonySwatch(swatchConfig.preset, keyColor, swatchConfig.harmony);
  } catch {
    try {
      harmonySwatch = [generateArc(simpleArc(keyColor))];
    } catch {
      harmonySwatch = [generateArc(simpleArc(SAFE_DEFAULT_HEX))];
    }
  }
  const swatch = harmonySwatch[0];

  let gradient: GradientPreset | undefined;
  const variantGradient = variantOverride?.gradient;
  if (variantGradient === null) {
    gradient = undefined;
  } else if (variantGradient) {
    gradient = getGradient(variantGradient.preset);
  } else if (definition.gradient) {
    gradient = getGradient(definition.gradient.preset);
  }

  return {
    asset,
    playerPaneFrame,
    swatch,
    harmonySwatch,
    colorMap,
    variant,
    keyColor,
    gradient,
  };
}
