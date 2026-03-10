/**
 * Resolve a color map value against a ResolvedTheme's harmony swatch.
 *
 * Encoding: values 0–99 index anchor 0 (key color arc).
 * Values ≥ 100 decode as anchor = floor(value / 100), step = value % 100.
 */

import type { ResolvedTheme } from "./types.js";

/** Look up a hex color from the harmony swatch by encoded index. */
export function resolveSwatchColor(theme: ResolvedTheme, value: number): string | undefined {
  if (value < 100) {
    return theme.swatch[value]?.hex;
  }
  const anchor = Math.floor(value / 100);
  const step = value % 100;
  return theme.harmonySwatch[anchor]?.[step]?.hex;
}

/** Look up a hex color for a named frame part. */
export function themeColor(theme: ResolvedTheme, part: keyof ResolvedTheme["colorMap"]): string | undefined {
  return resolveSwatchColor(theme, theme.colorMap[part]);
}
