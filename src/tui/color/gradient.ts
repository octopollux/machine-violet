/**
 * Per-character gradient engine for frame borders.
 *
 * Uses picture-frame lateral symmetry: t = 0 at edge center, t = 1 at endpoints.
 * Mirror-symmetric so both sides match.
 */

import type { CurveFunction } from "./curves.js";
import type { OklchColor } from "./oklch.js";
import { oklchToHex } from "./oklch.js";

// --- Types ---

/** Modulation for a single OKLCH channel. */
export interface ChannelModulation {
  /** Curve mapping t ∈ [0,1] → normalized position. */
  curve: CurveFunction;
  /** [min, max] offset range applied to the base channel value. */
  range: [number, number];
}

/** A named gradient preset with optional per-channel modulation. */
export interface GradientPreset {
  name: string;
  lightness?: ChannelModulation;
  chroma?: ChannelModulation;
  hue?: ChannelModulation;
}

/** A text segment with its computed color. */
export interface ColorizeSegment {
  text: string;
  color: string;
}

// --- Mirror-symmetric t mapping ---

/**
 * Map a position index within a length to t ∈ [0,1] with mirror symmetry.
 * t = 0 at the center, t = 1 at both endpoints.
 */
export function mirrorT(index: number, length: number): number {
  if (length <= 1) return 0;
  // center = (length - 1) / 2
  // distance from center, normalized to [0, 1]
  const center = (length - 1) / 2;
  return Math.abs(index - center) / center;
}

// --- Gradient application ---

function applyModulation(base: number, mod: ChannelModulation | undefined, t: number): number {
  if (!mod) return base;
  const curveVal = mod.curve(t);
  const offset = mod.range[0] + curveVal * (mod.range[1] - mod.range[0]);
  return base + offset;
}

/**
 * Apply a gradient preset to a base OKLCH color at position t.
 * Returns the resulting hex color string.
 */
export function applyGradient(preset: GradientPreset, baseOklch: OklchColor, t: number): string {
  const L = Math.max(0, Math.min(1, applyModulation(baseOklch.L, preset.lightness, t)));
  const C = Math.max(0, applyModulation(baseOklch.C, preset.chroma, t));
  let H = applyModulation(baseOklch.H, preset.hue, t);
  H = ((H % 360) + 360) % 360;
  return oklchToHex({ L, C, H });
}

// --- Segment colorization ---

/**
 * Colorize a string using per-character gradient.
 * Characters at the same position in the overall row share mirrorT symmetry.
 *
 * @param str - The string to colorize
 * @param preset - The gradient preset
 * @param baseOklch - Base OKLCH color
 * @param offset - Start offset of this string within the full row
 * @param totalLength - Total length of the full row (for mirrorT calculation)
 * @returns Array of segments, batching consecutive same-color characters
 */
export function colorizeSegments(
  str: string,
  preset: GradientPreset,
  baseOklch: OklchColor,
  offset: number,
  totalLength: number,
): ColorizeSegment[] {
  if (str.length === 0) return [];

  const segments: ColorizeSegment[] = [];
  let currentColor = "";
  let currentText = "";

  for (let i = 0; i < str.length; i++) {
    const t = mirrorT(offset + i, totalLength);
    const color = applyGradient(preset, baseOklch, t);
    if (color === currentColor) {
      currentText += str[i];
    } else {
      if (currentText) segments.push({ text: currentText, color: currentColor });
      currentColor = color;
      currentText = str[i];
    }
  }
  if (currentText) segments.push({ text: currentText, color: currentColor });

  return segments;
}

// --- Registry ---

const gradientRegistry = new Map<string, GradientPreset>();

/** Register a gradient preset. */
export function registerGradient(preset: GradientPreset): void {
  gradientRegistry.set(preset.name, preset);
}

/** Look up a gradient preset by name. Returns undefined if not found. */
export function getGradient(name: string): GradientPreset | undefined {
  return gradientRegistry.get(name);
}

/** List registered gradient preset names. */
export function listGradients(): string[] {
  return [...gradientRegistry.keys()];
}
