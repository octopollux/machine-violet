import { describe, it, expect } from "vitest";
import {
  createRng,
  fadeCurve,
  glyphForBrightness,
  buildGrid,
} from "./Starfield.js";

describe("createRng", () => {
  it("produces deterministic values from same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const valuesA = Array.from({ length: 10 }, () => a());
    const valuesB = Array.from({ length: 10 }, () => b());
    expect(valuesA).toEqual(valuesB);
  });

  it("produces values in [0, 1)", () => {
    const rng = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    const va = Array.from({ length: 5 }, () => a());
    const vb = Array.from({ length: 5 }, () => b());
    expect(va).not.toEqual(vb);
  });
});

describe("fadeCurve", () => {
  it("returns 0 at birth and death", () => {
    expect(fadeCurve(0, 60)).toBeCloseTo(0, 5);
    expect(fadeCurve(60, 60)).toBe(0);
  });

  it("peaks at midpoint", () => {
    const peak = fadeCurve(30, 60);
    expect(peak).toBeCloseTo(1.0, 5);
  });

  it("is symmetric around midpoint", () => {
    expect(fadeCurve(10, 60)).toBeCloseTo(fadeCurve(50, 60), 5);
    expect(fadeCurve(15, 60)).toBeCloseTo(fadeCurve(45, 60), 5);
  });

  it("returns 0 for out-of-range ages", () => {
    expect(fadeCurve(-1, 60)).toBe(0);
    expect(fadeCurve(61, 60)).toBe(0);
  });

  it("spends most of its life below half brightness (cubic sharpening)", () => {
    let aboveHalf = 0;
    for (let age = 0; age < 60; age++) {
      if (fadeCurve(age, 60) > 0.5) aboveHalf++;
    }
    // With sin³, only ~1/3 of frames are above 0.5 brightness
    expect(aboveHalf).toBeLessThanOrEqual(25);
  });
});

describe("glyphForBrightness", () => {
  it("returns dim glyph for low brightness", () => {
    expect(glyphForBrightness(0.05)).toBe("·");
    expect(glyphForBrightness(0.19)).toBe("·");
  });

  it("returns medium-dim glyph for mid-low brightness", () => {
    expect(glyphForBrightness(0.25)).toBe("∗");
    expect(glyphForBrightness(0.44)).toBe("∗");
  });

  it("returns medium-bright glyph", () => {
    expect(glyphForBrightness(0.50)).toBe("✦");
    expect(glyphForBrightness(0.69)).toBe("✦");
  });

  it("returns bright glyph for high brightness", () => {
    expect(glyphForBrightness(0.75)).toBe("★");
    expect(glyphForBrightness(1.0)).toBe("★");
  });

  it("respects maxTier cap", () => {
    // At full brightness, maxTier=1 caps at ∗
    expect(glyphForBrightness(1.0, 1)).toBe("∗");
    // maxTier=2 caps at ✦
    expect(glyphForBrightness(1.0, 2)).toBe("✦");
    // maxTier=0 caps at ·
    expect(glyphForBrightness(1.0, 0)).toBe("·");
  });
});

describe("buildGrid", () => {
  it("returns grid of correct dimensions", () => {
    const grid = buildGrid([], 10, 5, 0);
    expect(grid.length).toBe(5);
    for (const row of grid) {
      expect(row.length).toBe(10);
    }
  });

  it("returns all-null grid when there are no stars", () => {
    const grid = buildGrid([], 10, 5, 0);
    for (const row of grid) {
      for (const cell of row) {
        expect(cell).toBeNull();
      }
    }
  });

  it("places a star at its position", () => {
    const star = {
      x: 3,
      y: 2,
      birthFrame: 0,
      lifetime: 60,
      palette: { peakL: 0.9, C: 0, H: 0 },
      isQuasar: false,
    };
    const grid = buildGrid([star], 10, 5, 30); // frame 30 = peak brightness
    const cell = grid[2]![3];
    expect(cell).not.toBeNull();
    expect(cell!.glyph).toBe("★"); // peak brightness -> bright glyph
    expect(cell!.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("does not place dead stars", () => {
    const star = {
      x: 3,
      y: 2,
      birthFrame: 0,
      lifetime: 60,
      palette: { peakL: 0.9, C: 0, H: 0 },
      isQuasar: false,
    };
    const grid = buildGrid([star], 10, 5, 70); // past lifetime
    expect(grid[2]![3]).toBeNull();
  });

  it("places quasar arms", () => {
    const star = {
      x: 5,
      y: 3,
      birthFrame: 0,
      lifetime: 60,
      palette: { peakL: 0.9, C: 0, H: 0 },
      isQuasar: true,
    };
    const grid = buildGrid([star], 10, 7, 30);
    // Center
    expect(grid[3]![5]).not.toBeNull();
    expect(grid[3]![5]!.glyph).toBe("╋");
    // Cardinal arms
    expect(grid[2]![5]!.glyph).toBe("│"); // up
    expect(grid[4]![5]!.glyph).toBe("│"); // down
    expect(grid[3]![4]!.glyph).toBe("─"); // left
    expect(grid[3]![6]!.glyph).toBe("─"); // right
    // Outer tips
    expect(grid[1]![5]!.glyph).toBe("·"); // up-2
    expect(grid[5]![5]!.glyph).toBe("·"); // down-2
  });

  it("clips quasar arms at grid boundaries", () => {
    const star = {
      x: 0,
      y: 0,
      birthFrame: 0,
      lifetime: 60,
      palette: { peakL: 0.9, C: 0, H: 0 },
      isQuasar: true,
    };
    // Should not throw; arms extending off-grid are simply clipped
    const grid = buildGrid([star], 3, 3, 30);
    expect(grid[0]![0]!.glyph).toBe("╋");
    expect(grid[0]![1]!.glyph).toBe("─"); // right arm fits
  });

  it("produces colored stars (orange)", () => {
    const star = {
      x: 2,
      y: 1,
      birthFrame: 0,
      lifetime: 60,
      palette: { peakL: 0.75, C: 0.14, H: 65 }, // orange
      isQuasar: false,
    };
    const grid = buildGrid([star], 5, 3, 30);
    const cell = grid[1]![2]!;
    // Orange star at peak: should produce a warm hex color, not pure grey
    const r = parseInt(cell.color.slice(1, 3), 16);
    const g = parseInt(cell.color.slice(3, 5), 16);
    const b = parseInt(cell.color.slice(5, 7), 16);
    expect(r).toBeGreaterThan(g); // orange has more red than green
    expect(r).toBeGreaterThan(b); // and more red than blue
  });
});
