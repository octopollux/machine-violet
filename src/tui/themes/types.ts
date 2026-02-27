/**
 * Theme system types for multi-line ASCII art borders.
 */

import type { Color, SwatchParams, HarmonyType } from "../color/index.js";

/** A single theme component (corner, edge, separator, etc.) */
export interface ThemeComponent {
  /** Rows of the component, top to bottom. */
  rows: string[];
  /** Display width of the widest row. */
  width: number;
  /** Number of rows. */
  height: number;
}

/** All required component names for a theme asset. */
export const REQUIRED_COMPONENTS = [
  "corner_tl",
  "corner_tr",
  "corner_bl",
  "corner_br",
  "edge_top",
  "edge_bottom",
  "edge_left",
  "edge_right",
  "separator_left_top",
  "separator_right_top",
  "separator_left_bottom",
  "separator_right_bottom",
  "turn_separator",
] as const;

export type ComponentName = (typeof REQUIRED_COMPONENTS)[number];

/** Parsed theme asset — all border components + metadata. */
export interface ThemeAsset {
  name: string;
  genreTags: string[];
  height: number;
  components: Record<ComponentName, ThemeComponent>;
}

/** Maps swatch indices to frame parts for coloring. */
export interface ThemeColorMap {
  /** Index into swatch for the frame border. */
  border: number;
  /** Index into swatch for corner decorations. */
  corner: number;
  /** Index into swatch for separator elements. */
  separator: number;
  /** Index into swatch for the title text. */
  title: number;
  /** Index into swatch for turn indicator text. */
  turnIndicator: number;
  /** Index into swatch for side frame. */
  sideFrame: number;
}

/** Swatch configuration for generating colors from a key color. */
export interface SwatchConfig {
  preset: string;
  harmony: HarmonyType;
  /** Override SwatchParams fields. */
  overrides?: Partial<SwatchParams>;
}

/** Style variant — same names as the old system for continuity. */
export type StyleVariant = "exploration" | "combat" | "ooc" | "levelup" | "dev";

/** Per-variant overrides (e.g. combat uses different colors). */
export interface VariantOverride {
  swatchConfig?: Partial<SwatchConfig>;
  colorMap?: Partial<ThemeColorMap>;
}

/** Full theme definition — asset reference + swatch config + variant overrides. */
export interface ThemeDefinition {
  /** Name of the theme asset file (without .theme extension). */
  assetName: string;
  /** Default swatch configuration. */
  swatchConfig: SwatchConfig;
  /** Default color map. */
  colorMap: ThemeColorMap;
  /** Per-variant overrides. */
  variants?: Partial<Record<StyleVariant, VariantOverride>>;
}

/** Fully resolved theme ready for rendering. */
export interface ResolvedTheme {
  asset: ThemeAsset;
  swatch: Color[];
  colorMap: ThemeColorMap;
  variant: StyleVariant;
  /** The key color used to generate this theme. */
  keyColor: string;
}
