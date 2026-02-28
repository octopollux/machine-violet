import { describe, it, expect } from "vitest";
import { oklchToHex, hexToOklch, gamutClamp, hexToRgb } from "./oklch.js";

describe("oklch", () => {
  describe("hexToOklch → oklchToHex round-trip", () => {
    const cases = ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#ff8800", "#8844cc"];

    for (const hex of cases) {
      it(`round-trips ${hex}`, () => {
        const oklch = hexToOklch(hex);
        const back = oklchToHex(oklch);
        // Hex values may differ by ±1 per channel due to floating-point
        const orig = hexToRgb(hex);
        const result = hexToRgb(back);
        expect(Math.abs(orig.r - result.r)).toBeLessThanOrEqual(1);
        expect(Math.abs(orig.g - result.g)).toBeLessThanOrEqual(1);
        expect(Math.abs(orig.b - result.b)).toBeLessThanOrEqual(1);
      });
    }
  });

  describe("hexToOklch", () => {
    it("parses black", () => {
      const c = hexToOklch("#000000");
      expect(c.L).toBeCloseTo(0, 2);
      expect(c.C).toBeCloseTo(0, 2);
    });

    it("parses white", () => {
      const c = hexToOklch("#ffffff");
      expect(c.L).toBeCloseTo(1, 2);
      expect(c.C).toBeCloseTo(0, 2);
    });

    it("handles hex without #", () => {
      const a = hexToOklch("#ff0000");
      const b = hexToOklch("ff0000");
      expect(a.L).toBeCloseTo(b.L, 5);
      expect(a.C).toBeCloseTo(b.C, 5);
      expect(a.H).toBeCloseTo(b.H, 5);
    });

    it("throws on invalid hex", () => {
      expect(() => hexToOklch("zzzzzz")).toThrow();
      expect(() => hexToOklch("#fff")).toThrow();
    });
  });

  describe("oklchToHex", () => {
    it("converts mid-gray", () => {
      const hex = oklchToHex({ L: 0.5, C: 0, H: 0 });
      const rgb = hexToRgb(hex);
      // Gray: all channels equal
      expect(Math.abs(rgb.r - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(rgb.g - rgb.b)).toBeLessThanOrEqual(1);
    });

    it("output format is lowercase hex with #", () => {
      const hex = oklchToHex({ L: 0.7, C: 0.1, H: 120 });
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  describe("gamutClamp", () => {
    it("returns input unchanged if already in gamut", () => {
      const oklch = hexToOklch("#888888");
      const clamped = gamutClamp(oklch);
      expect(clamped.L).toBeCloseTo(oklch.L, 5);
      expect(clamped.C).toBeCloseTo(oklch.C, 5);
      expect(clamped.H).toBeCloseTo(oklch.H, 5);
    });

    it("reduces chroma for out-of-gamut colors", () => {
      const outOfGamut = { L: 0.9, C: 0.4, H: 150 };
      const clamped = gamutClamp(outOfGamut);
      expect(clamped.C).toBeLessThan(outOfGamut.C);
      expect(clamped.L).toBeCloseTo(outOfGamut.L, 5);
      expect(clamped.H).toBeCloseTo(outOfGamut.H, 5);
    });

    it("preserves hue and lightness", () => {
      const input = { L: 0.5, C: 0.35, H: 270 };
      const clamped = gamutClamp(input);
      expect(clamped.L).toBeCloseTo(input.L, 5);
      expect(clamped.H).toBeCloseTo(input.H, 5);
    });
  });

  describe("hexToRgb", () => {
    it("parses hex to RGB", () => {
      expect(hexToRgb("#ff8800")).toEqual({ r: 255, g: 136, b: 0 });
    });

    it("handles without #", () => {
      expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    });
  });
});
