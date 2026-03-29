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

/**
 * Derive a modal-specific theme by shifting colors to anchor 1 (complementary
 * hue, 180° away) and mirroring step indices (inverted lightness).
 *
 * This makes modals visually offset from the main game frame — darker where the
 * frame is light, and in the complementary hue.
 */
export function deriveModalTheme(theme: ResolvedTheme): ResolvedTheme {
  const steps = theme.swatch.length;
  const mirrorStep = (step: number): number =>
    steps > 1 ? steps - 1 - Math.min(step, steps - 1) : 0;

  const newColorMap = {} as ResolvedTheme["colorMap"];
  for (const [part, value] of Object.entries(theme.colorMap)) {
    const step = value % 100;
    newColorMap[part as keyof ResolvedTheme["colorMap"]] = 100 + mirrorStep(step);
  }

  return { ...theme, colorMap: newColorMap };
}
