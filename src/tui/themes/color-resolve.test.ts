import { describe, it, expect } from "vitest";
import { resolveSwatchColor, themeColor, deriveModalTheme } from "./color-resolve.js";
import type { ResolvedTheme } from "./types.js";

function makeTheme(overrides?: Partial<ResolvedTheme>): ResolvedTheme {
  const swatch = [
    { hex: "#000000", oklch: { L: 0, C: 0, H: 0 } },
    { hex: "#111111", oklch: { L: 0.1, C: 0, H: 0 } },
    { hex: "#222222", oklch: { L: 0.2, C: 0, H: 0 } },
    { hex: "#333333", oklch: { L: 0.3, C: 0, H: 0 } },
  ];
  const row1 = [
    { hex: "#aa0000", oklch: { L: 0.5, C: 0.1, H: 30 } },
    { hex: "#bb0000", oklch: { L: 0.6, C: 0.1, H: 30 } },
    { hex: "#cc0000", oklch: { L: 0.7, C: 0.1, H: 30 } },
    { hex: "#dd0000", oklch: { L: 0.8, C: 0.1, H: 30 } },
  ];
  const row2 = [
    { hex: "#0000aa", oklch: { L: 0.5, C: 0.1, H: 240 } },
    { hex: "#0000bb", oklch: { L: 0.6, C: 0.1, H: 240 } },
    { hex: "#0000cc", oklch: { L: 0.7, C: 0.1, H: 240 } },
    { hex: "#0000dd", oklch: { L: 0.8, C: 0.1, H: 240 } },
  ];
  return {
    swatch,
    harmonySwatch: [swatch, row1, row2],
    colorMap: { border: 2, corner: 103, separator: 201, title: 3, turnIndicator: 0, sideFrame: 1 },
    ...overrides,
  } as ResolvedTheme;
}

describe("resolveSwatchColor", () => {
  const theme = makeTheme();

  it("values < 100 index anchor 0 (key color arc)", () => {
    expect(resolveSwatchColor(theme, 0)).toBe("#000000");
    expect(resolveSwatchColor(theme, 2)).toBe("#222222");
    expect(resolveSwatchColor(theme, 3)).toBe("#333333");
  });

  it("values >= 100 decode as anchor * 100 + step", () => {
    expect(resolveSwatchColor(theme, 100)).toBe("#aa0000"); // anchor 1, step 0
    expect(resolveSwatchColor(theme, 103)).toBe("#dd0000"); // anchor 1, step 3
    expect(resolveSwatchColor(theme, 201)).toBe("#0000bb"); // anchor 2, step 1
  });

  it("returns undefined for out-of-range step", () => {
    expect(resolveSwatchColor(theme, 99)).toBeUndefined();
  });

  it("returns undefined for out-of-range anchor", () => {
    expect(resolveSwatchColor(theme, 500)).toBeUndefined();
  });
});

describe("themeColor", () => {
  const theme = makeTheme();

  it("resolves flat index (border = 2)", () => {
    expect(themeColor(theme, "border")).toBe("#222222");
  });

  it("resolves harmony index (corner = 103)", () => {
    expect(themeColor(theme, "corner")).toBe("#dd0000");
  });

  it("resolves harmony index (separator = 201)", () => {
    expect(themeColor(theme, "separator")).toBe("#0000bb");
  });
});

describe("deriveModalTheme", () => {
  it("shifts all colorMap values to anchor 1 with mirrored steps", () => {
    // 4 steps per row (0,1,2,3). Mirror: 0→3, 1→2, 2→1, 3→0
    const theme = makeTheme({
      colorMap: { border: 2, corner: 3, separator: 0, title: 1, turnIndicator: 0, sideFrame: 1 },
    });
    const modal = deriveModalTheme(theme);
    // border: step 2 → mirror 1 → 101
    expect(modal.colorMap.border).toBe(101);
    // corner: step 3 → mirror 0 → 100
    expect(modal.colorMap.corner).toBe(100);
    // separator: step 0 → mirror 3 → 103
    expect(modal.colorMap.separator).toBe(103);
    // title: step 1 → mirror 2 → 102
    expect(modal.colorMap.title).toBe(102);
  });

  it("resolves derived colors from anchor 1 row", () => {
    const theme = makeTheme({
      colorMap: { border: 2, corner: 3, separator: 0, title: 1, turnIndicator: 0, sideFrame: 1 },
    });
    const modal = deriveModalTheme(theme);
    // border → 101 → anchor 1 step 1 → #bb0000
    expect(themeColor(modal, "border")).toBe("#bb0000");
    // corner → 100 → anchor 1 step 0 → #aa0000
    expect(themeColor(modal, "corner")).toBe("#aa0000");
  });

  it("preserves non-colorMap theme properties", () => {
    const theme = makeTheme();
    const modal = deriveModalTheme(theme);
    expect(modal.swatch).toBe(theme.swatch);
    expect(modal.harmonySwatch).toBe(theme.harmonySwatch);
    expect(modal.asset).toBe(theme.asset);
  });
});
