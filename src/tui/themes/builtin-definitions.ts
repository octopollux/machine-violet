/**
 * Built-in theme definitions.
 * Maps theme names to their ThemeDefinition configs.
 */

import type { ThemeDefinition, ThemeColorMap } from "./types.js";

/** Default color map — swatch index assignments for frame parts. */
const DEFAULT_COLOR_MAP: ThemeColorMap = {
  border: 2,
  corner: 3,
  separator: 4,
  title: 5,
  turnIndicator: 6,
  sideFrame: 1,
};

export const BUILTIN_DEFINITIONS: Record<string, ThemeDefinition> = {
  gothic: {
    assetName: "gothic",
    swatchConfig: { preset: "ember", harmony: "analogous" },
    colorMap: { ...DEFAULT_COLOR_MAP },
    variants: {
      combat: {
        swatchConfig: { preset: "ember" },
        colorMap: { border: 6, corner: 7 },
      },
      ooc: {
        swatchConfig: { preset: "ethereal" },
        colorMap: { border: 1, corner: 2 },
      },
    },
  },

  arcane: {
    assetName: "arcane",
    swatchConfig: { preset: "ethereal", harmony: "triadic" },
    colorMap: { ...DEFAULT_COLOR_MAP },
    variants: {
      combat: {
        swatchConfig: { preset: "cyberpunk" },
        colorMap: { border: 5, corner: 6 },
      },
    },
  },

  terminal: {
    assetName: "terminal",
    swatchConfig: { preset: "cyberpunk", harmony: "complementary" },
    colorMap: { ...DEFAULT_COLOR_MAP, border: 1, sideFrame: 0 },
    variants: {
      combat: {
        colorMap: { border: 7, corner: 8 },
      },
      ooc: {
        swatchConfig: { preset: "ethereal" },
      },
    },
  },

  clean: {
    assetName: "clean",
    swatchConfig: { preset: "foliage", harmony: "analogous" },
    colorMap: { ...DEFAULT_COLOR_MAP, border: 0, corner: 0, separator: 0 },
  },
};

/** Get a built-in theme definition by name. */
export function getBuiltinDefinition(name: string): ThemeDefinition | undefined {
  return BUILTIN_DEFINITIONS[name];
}

/** List available built-in theme definition names. */
export function listBuiltinDefinitions(): string[] {
  return Object.keys(BUILTIN_DEFINITIONS);
}
