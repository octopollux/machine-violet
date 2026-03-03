import { describe, it, expect } from "vitest";
import {
  mirrorT,
  applyGradient,
  colorizeSegments,
  registerGradient,
  getGradient,
  listGradients,
} from "./gradient.js";
import type { GradientPreset, ChannelModulation } from "./gradient.js";
import { hexToOklch } from "./oklch.js";
import { linearRamp, constant } from "./curves.js";

describe("mirrorT", () => {
  it("is symmetric: mirrorT(i, n) === mirrorT(n-1-i, n)", () => {
    const n = 10;
    for (let i = 0; i < n; i++) {
      expect(mirrorT(i, n)).toBeCloseTo(mirrorT(n - 1 - i, n), 10);
    }
  });

  it("is symmetric for odd-length strings", () => {
    const n = 11;
    for (let i = 0; i < n; i++) {
      expect(mirrorT(i, n)).toBeCloseTo(mirrorT(n - 1 - i, n), 10);
    }
  });

  it("returns 0 for center position", () => {
    // Even length: center is between two elements, both closest get near-zero
    expect(mirrorT(4, 9)).toBe(0); // exact center at index 4
    expect(mirrorT(5, 11)).toBe(0); // exact center at index 5
  });

  it("returns 1 at endpoints", () => {
    expect(mirrorT(0, 10)).toBeCloseTo(1, 10);
    expect(mirrorT(9, 10)).toBeCloseTo(1, 10);
  });

  it("returns 0 for length=1", () => {
    expect(mirrorT(0, 1)).toBe(0);
  });

  it("returns 0 for length=0", () => {
    expect(mirrorT(0, 0)).toBe(0);
  });
});

describe("applyGradient", () => {
  const baseOklch = hexToOklch("#888888");

  it("with no modulations returns base color unchanged", () => {
    const preset: GradientPreset = { name: "noop" };
    const result = applyGradient(preset, baseOklch, 0);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    // Same at t=0 and t=1 when no modulations
    const r0 = applyGradient(preset, baseOklch, 0);
    const r1 = applyGradient(preset, baseOklch, 1);
    expect(r0).toBe(r1);
  });

  it("with single-channel lightness modulation varies with t", () => {
    const mod: ChannelModulation = { curve: linearRamp(0, 1), range: [0, -0.15] };
    const preset: GradientPreset = { name: "test-l", lightness: mod };

    const atCenter = applyGradient(preset, baseOklch, 0);
    const atEdge = applyGradient(preset, baseOklch, 1);
    // At t=0: linearRamp(0,1)(0)=0, offset=0+0*(-.15)=0 → base
    // At t=1: linearRamp(0,1)(1)=1, offset=0+1*(-.15)=-0.15 → darker
    expect(atCenter).toMatch(/^#[0-9a-f]{6}$/);
    expect(atEdge).toMatch(/^#[0-9a-f]{6}$/);
    expect(atCenter).not.toBe(atEdge);
  });

  it("with all channels produces valid hex", () => {
    const preset: GradientPreset = {
      name: "test-all",
      lightness: { curve: linearRamp(0, 1), range: [0, -0.1] },
      chroma: { curve: linearRamp(0, 1), range: [0, -0.03] },
      hue: { curve: linearRamp(0, 1), range: [0, 20] },
    };
    for (let t = 0; t <= 1; t += 0.1) {
      const hex = applyGradient(preset, baseOklch, t);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("clamps lightness to [0, 1]", () => {
    const preset: GradientPreset = {
      name: "test-clamp",
      lightness: { curve: constant(1), range: [0, 2] }, // would push L above 1
    };
    const hex = applyGradient(preset, baseOklch, 1);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("colorizeSegments", () => {
  const baseOklch = hexToOklch("#888888");

  it("returns empty array for empty string", () => {
    const preset: GradientPreset = { name: "noop" };
    expect(colorizeSegments("", preset, baseOklch, 0, 10)).toEqual([]);
  });

  it("flat gradient produces single segment", () => {
    const preset: GradientPreset = { name: "flat" };
    const segments = colorizeSegments("abcde", preset, baseOklch, 0, 5);
    // No modulations → all characters get the same color
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("abcde");
  });

  it("varying gradient produces multiple segments", () => {
    const preset: GradientPreset = {
      name: "vary",
      lightness: { curve: linearRamp(0, 1), range: [0, -0.3] },
    };
    // Long string so mirrorT produces distinct colors
    const str = "a".repeat(40);
    const segments = colorizeSegments(str, preset, baseOklch, 0, 40);
    expect(segments.length).toBeGreaterThan(1);
    // Total text should reconstruct the original
    const reconstructed = segments.map((s) => s.text).join("");
    expect(reconstructed).toBe(str);
  });

  it("preserves text content across segments", () => {
    const preset: GradientPreset = {
      name: "test",
      hue: { curve: linearRamp(0, 1), range: [0, 60] },
    };
    const str = "Hello World";
    const segments = colorizeSegments(str, preset, baseOklch, 0, str.length);
    const reconstructed = segments.map((s) => s.text).join("");
    expect(reconstructed).toBe(str);
    for (const seg of segments) {
      expect(seg.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("respects offset for mirrorT calculation", () => {
    const preset: GradientPreset = {
      name: "off",
      lightness: { curve: linearRamp(0, 1), range: [0, -0.3] },
    };
    // Same string, different offset → different color distribution
    const seg1 = colorizeSegments("aaa", preset, baseOklch, 0, 20);
    const seg2 = colorizeSegments("aaa", preset, baseOklch, 10, 20);
    // At least the first segment colors should differ
    expect(seg1[0].color).not.toBe(seg2[0].color);
  });
});

describe("gradient registry", () => {
  it("round-trips a preset", () => {
    const preset: GradientPreset = {
      name: "test-roundtrip",
      lightness: { curve: linearRamp(0, 1), range: [0, -0.1] },
    };
    registerGradient(preset);
    expect(getGradient("test-roundtrip")).toBe(preset);
    expect(listGradients()).toContain("test-roundtrip");
  });

  it("returns undefined for unknown preset", () => {
    expect(getGradient("nonexistent-gradient")).toBeUndefined();
  });
});
