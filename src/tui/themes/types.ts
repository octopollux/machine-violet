/**
 * Theme system types for multi-line ASCII art borders.
 */

import type { Color, SwatchParams, HarmonyType, GradientPreset } from "../color/index.js";

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

/** All required component names for a player pane frame. */
export const PLAYER_PANE_COMPONENTS = [
  "corner_tl",
  "corner_tr",
  "corner_bl",
  "corner_br",
  "edge_top",
  "edge_bottom",
  "edge_left",
  "edge_right",
] as const;

export type PlayerPaneComponentName = (typeof PLAYER_PANE_COMPONENTS)[number];

/** Edge components that are optional in .player-frame files.
 *  When absent or empty, they default to a single space (renders as blank). */
export const PLAYER_PANE_EDGE_COMPONENTS: ReadonlySet<PlayerPaneComponentName> = new Set([
  "edge_top",
  "edge_bottom",
  "edge_left",
  "edge_right",
]);

/** Parsed player pane frame — 8 border components, always height 1. */
export interface PlayerPaneFrame {
  name: string;
  components: Record<PlayerPaneComponentName, ThemeComponent>;
}

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

/** Gradient configuration for per-character border color variation. */
export interface GradientConfig {
  /** Name of a registered gradient preset. */
  preset: string;
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
  /** Override gradient; null disables gradient for this variant. */
  gradient?: GradientConfig | null;
}

/** Full theme definition — asset reference + swatch config + variant overrides. */
export interface ThemeDefinition {
  /** Name of the theme asset file (without .theme extension). */
  assetName: string;
  /** Name of the player-frame asset file (without .player-frame extension). Defaults to "default". */
  playerFrameName?: string;
  /** Default swatch configuration. */
  swatchConfig: SwatchConfig;
  /** Default color map. */
  colorMap: ThemeColorMap;
  /** Gradient configuration for per-character border variation. */
  gradient?: GradientConfig;
  /** Per-variant overrides. */
  variants?: Partial<Record<StyleVariant, VariantOverride>>;
}

/** Fully resolved theme ready for rendering. */
export interface ResolvedTheme {
  asset: ThemeAsset;
  playerPaneFrame: PlayerPaneFrame;
  swatch: Color[];
  colorMap: ThemeColorMap;
  variant: StyleVariant;
  /** The key color used to generate this theme. */
  keyColor: string;
  /** Resolved gradient preset, if configured. */
  gradient?: GradientPreset;
}
