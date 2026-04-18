/**
 * Build a ThemeDefinition from parsed .theme file config.
 * Mirrors loader.loadThemeDefinition() minus the filesystem read.
 */

import type { ThemeDefinition, ThemeColorMap } from "@engine-src/tui/themes/types.js";
import { extractThemeConfig, parseSections } from "@engine-src/tui/themes/parser.js";

const DEFAULT_COLOR_MAP: ThemeColorMap = {
  border: 2,
  corner: 3,
  separator: 4,
  title: 5,
  turnIndicator: 6,
  sideFrame: 1,
};

export function buildDefinition(themeName: string, themeContent: string): ThemeDefinition {
  const parsed = parseSections(themeContent);
  const config = extractThemeConfig(parsed.metadata, parsed.sections);

  const definition: ThemeDefinition = {
    assetName: themeName,
    swatchConfig: {
      preset: config.swatchConfig?.preset ?? "foliage",
      harmony: config.swatchConfig?.harmony ?? "analogous",
      ...config.swatchConfig,
    },
    colorMap: {
      ...DEFAULT_COLOR_MAP,
      ...config.colorMap,
    },
  };

  if (config.gradient) {
    definition.gradient = config.gradient;
  }
  if (config.playerFrameName) {
    definition.playerFrameName = config.playerFrameName;
  }
  if (config.variants) {
    definition.variants = config.variants;
  }

  return definition;
}
