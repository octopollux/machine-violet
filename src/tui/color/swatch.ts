/**
 * Core swatch types and arc generation.
 * Generates a palette of OKLCH colors by sweeping through a hue arc
 * with parameterised chroma and lightness curves.
 */

import { type CurveFunction, constant, linearRamp } from "./curves.js";
import { type OklchColor, oklchToHex, hexToOklch } from "./oklch.js";

// --- Types ---

export interface HueArc {
  hStart: number;
  hEnd: number;
  direction: "cw" | "ccw" | "shortest";
}

export interface SwatchParams {
  arc: HueArc;
  steps: number;
  chromaCurve: CurveFunction;
  lightnessCurve: CurveFunction;
  /** Chroma range: curve output is mapped from [0,1] to [min, max]. */
  chromaRange: [number, number];
  /** Lightness range: curve output is mapped from [0,1] to [min, max]. */
  lightnessRange: [number, number];
}

export interface Color {
  hex: string;
  oklch: OklchColor;
}

export type HarmonyType =
  | "analogous"
  | "complementary"
  | "split-complementary"
  | "triadic"
  | "tetradic";

// --- Hue interpolation ---

function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/**
 * Resolve the arc into a signed delta.
 * CW = increasing hue, CCW = decreasing hue.
 * "shortest" picks the direction with the smallest angular distance.
 */
function resolveArcDelta(arc: HueArc): number {
  const start = normalizeHue(arc.hStart);
  const end = normalizeHue(arc.hEnd);

  // CW delta (positive direction)
  const cwDelta = ((end - start) % 360 + 360) % 360;
  // CCW delta (negative direction)
  const ccwDelta = cwDelta - 360;

  switch (arc.direction) {
    case "cw":
      return cwDelta === 0 ? 360 : cwDelta;
    case "ccw":
      return ccwDelta === 0 ? -360 : ccwDelta;
    case "shortest":
      return Math.abs(cwDelta) <= Math.abs(ccwDelta) ? cwDelta : ccwDelta;
  }
}

function mapRange(t: number, range: [number, number]): number {
  return range[0] + t * (range[1] - range[0]);
}

// --- Arc generation ---

/**
 * Generate a swatch of `steps` colors by sweeping through a hue arc.
 * Chroma and lightness at each step are determined by the provided curve functions.
 */
export function generateArc(params: SwatchParams): Color[] {
  const { arc, steps, chromaCurve, lightnessCurve, chromaRange, lightnessRange } = params;
  if (steps < 1) return [];

  const delta = resolveArcDelta(arc);
  const startHue = normalizeHue(arc.hStart);
  const colors: Color[] = [];

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const H = normalizeHue(startHue + delta * t);
    const C = mapRange(chromaCurve(t), chromaRange);
    const L = mapRange(lightnessCurve(t), lightnessRange);

    const oklch: OklchColor = { L, C, H };
    const hex = oklchToHex(oklch);
    colors.push({ hex, oklch });
  }

  return colors;
}

// --- Harmony anchors ---

/**
 * Generate harmony anchor hues from a base hex color.
 * Returns an array of hue angles.
 */
export function generateAnchors(baseHex: string, harmony: HarmonyType): number[] {
  const { H } = hexToOklch(baseHex);

  switch (harmony) {
    case "analogous":
      return [normalizeHue(H - 30), H, normalizeHue(H + 30)];
    case "complementary":
      return [H, normalizeHue(H + 180)];
    case "split-complementary":
      return [H, normalizeHue(H + 150), normalizeHue(H + 210)];
    case "triadic":
      return [H, normalizeHue(H + 120), normalizeHue(H + 240)];
    case "tetradic":
      return [H, normalizeHue(H + 90), normalizeHue(H + 180), normalizeHue(H + 270)];
  }
}

// --- Presets ---

export interface PresetFactory {
  name: string;
  build(baseHex: string): SwatchParams;
}

const presetRegistry = new Map<string, PresetFactory>();

export function registerPreset(preset: PresetFactory): void {
  presetRegistry.set(preset.name, preset);
}

/**
 * Generate a swatch from a named preset and a base (key) color hex.
 */
export function fromPreset(name: string, baseHex: string): Color[] {
  const preset = presetRegistry.get(name);
  if (!preset) throw new Error(`Unknown color preset: ${name}`);
  return generateArc(preset.build(baseHex));
}

export function listPresets(): string[] {
  return [...presetRegistry.keys()];
}

export function getPreset(name: string): PresetFactory | undefined {
  return presetRegistry.get(name);
}

// --- Default params helper ---

/** Convenience: build SwatchParams from a base hex and simple overrides. */
export function simpleArc(
  baseHex: string,
  opts: {
    span?: number;
    direction?: HueArc["direction"];
    steps?: number;
    chromaCurve?: CurveFunction;
    lightnessCurve?: CurveFunction;
    chromaRange?: [number, number];
    lightnessRange?: [number, number];
  } = {},
): SwatchParams {
  const { H } = hexToOklch(baseHex);
  const span = opts.span ?? 60;
  const direction = opts.direction ?? "cw";

  return {
    arc: {
      hStart: normalizeHue(H - span / 2),
      hEnd: normalizeHue(H + span / 2),
      direction,
    },
    steps: opts.steps ?? 8,
    chromaCurve: opts.chromaCurve ?? constant(0.5),
    lightnessCurve: opts.lightnessCurve ?? linearRamp(0.3, 0.8),
    chromaRange: opts.chromaRange ?? [0.02, 0.15],
    lightnessRange: opts.lightnessRange ?? [0.25, 0.85],
  };
}
