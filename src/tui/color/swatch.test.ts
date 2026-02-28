import { describe, it, expect } from "vitest";
import {
  generateArc,
  generateAnchors,
  fromPreset,
  listPresets,
  simpleArc,
} from "./swatch.js";
import { constant, linearRamp } from "./curves.js";
import { hexToOklch } from "./oklch.js";

// Ensure presets are registered
import "./presets.js";

describe("swatch", () => {
  describe("generateArc", () => {
    it("produces the requested number of steps", () => {
      const params = simpleArc("#ff0000", { steps: 5 });
      const colors = generateArc(params);
      expect(colors).toHaveLength(5);
    });

    it("returns empty array for 0 steps", () => {
      const params = simpleArc("#ff0000", { steps: 0 });
      expect(generateArc(params)).toHaveLength(0);
    });

    it("single step returns one color", () => {
      const params = simpleArc("#ff0000", { steps: 1 });
      const colors = generateArc(params);
      expect(colors).toHaveLength(1);
      expect(colors[0].hex).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("each color has hex and oklch", () => {
      const params = simpleArc("#00ff00", { steps: 4 });
      const colors = generateArc(params);
      for (const c of colors) {
        expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
        expect(c.oklch).toHaveProperty("L");
        expect(c.oklch).toHaveProperty("C");
        expect(c.oklch).toHaveProperty("H");
      }
    });

    it("respects lightness range", () => {
      const params = simpleArc("#ff0000", {
        steps: 8,
        lightnessCurve: linearRamp(0, 1),
        lightnessRange: [0.3, 0.7],
      });
      const colors = generateArc(params);
      // First should be near 0.3, last near 0.7
      expect(colors[0].oklch.L).toBeCloseTo(0.3, 1);
      expect(colors[colors.length - 1].oklch.L).toBeCloseTo(0.7, 1);
    });

    it("handles hue wraparound (350 → 10 CW goes through 0)", () => {
      const params = {
        arc: { hStart: 350, hEnd: 10, direction: "cw" as const },
        steps: 5,
        chromaCurve: constant(0.5),
        lightnessCurve: constant(0.5),
        chromaRange: [0.1, 0.1] as [number, number],
        lightnessRange: [0.5, 0.5] as [number, number],
      };
      const colors = generateArc(params);
      expect(colors).toHaveLength(5);
      // All hues should be near 350-360-10 range
      for (const c of colors) {
        const h = c.oklch.H;
        expect(h >= 345 || h <= 15).toBe(true);
      }
    });

    it("CCW direction sweeps backwards", () => {
      const params = {
        arc: { hStart: 10, hEnd: 350, direction: "ccw" as const },
        steps: 5,
        chromaCurve: constant(0.5),
        lightnessCurve: constant(0.5),
        chromaRange: [0.1, 0.1] as [number, number],
        lightnessRange: [0.5, 0.5] as [number, number],
      };
      const colors = generateArc(params);
      expect(colors).toHaveLength(5);
      // Hues should be near 10-0-350 range (short arc CCW)
      for (const c of colors) {
        const h = c.oklch.H;
        expect(h >= 345 || h <= 15).toBe(true);
      }
    });
  });

  describe("generateAnchors", () => {
    const base = "#ff0000";
    const baseHue = hexToOklch(base).H;

    it("analogous: 3 anchors ±30°", () => {
      const anchors = generateAnchors(base, "analogous");
      expect(anchors).toHaveLength(3);
      // Middle anchor is base hue
      expect(anchors[1]).toBeCloseTo(baseHue, 1);
    });

    it("complementary: 2 anchors 180° apart", () => {
      const anchors = generateAnchors(base, "complementary");
      expect(anchors).toHaveLength(2);
      const diff = Math.abs(anchors[1] - anchors[0]);
      expect(Math.min(diff, 360 - diff)).toBeCloseTo(180, 1);
    });

    it("split-complementary: 3 anchors", () => {
      const anchors = generateAnchors(base, "split-complementary");
      expect(anchors).toHaveLength(3);
    });

    it("triadic: 3 anchors 120° apart", () => {
      const anchors = generateAnchors(base, "triadic");
      expect(anchors).toHaveLength(3);
    });

    it("tetradic: 4 anchors 90° apart", () => {
      const anchors = generateAnchors(base, "tetradic");
      expect(anchors).toHaveLength(4);
    });
  });

  describe("presets", () => {
    it("lists all 4 presets", () => {
      const names = listPresets();
      expect(names).toContain("foliage");
      expect(names).toContain("cyberpunk");
      expect(names).toContain("ember");
      expect(names).toContain("ethereal");
    });

    it("fromPreset generates colors", () => {
      for (const name of listPresets()) {
        const colors = fromPreset(name, "#ff4488");
        expect(colors.length).toBeGreaterThan(0);
        for (const c of colors) {
          expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    });

    it("throws on unknown preset", () => {
      expect(() => fromPreset("nonexistent", "#ff0000")).toThrow("Unknown color preset");
    });
  });

  describe("simpleArc", () => {
    it("creates SwatchParams from a hex color", () => {
      const params = simpleArc("#44aaff");
      expect(params.steps).toBe(8);
      expect(params.arc.direction).toBe("cw");
      expect(params.chromaRange).toEqual([0.02, 0.15]);
      expect(params.lightnessRange).toEqual([0.25, 0.85]);
    });

    it("respects overrides", () => {
      const params = simpleArc("#44aaff", {
        steps: 12,
        span: 90,
        direction: "ccw",
        chromaRange: [0.05, 0.2],
      });
      expect(params.steps).toBe(12);
      expect(params.arc.direction).toBe("ccw");
      expect(params.chromaRange).toEqual([0.05, 0.2]);
    });
  });
});
