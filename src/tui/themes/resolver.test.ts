import { describe, it, expect, beforeEach } from "vitest";
import { resolveTheme } from "./resolver.js";
import { resetThemeCache } from "./loader.js";
import { BUILTIN_DEFINITIONS } from "./builtin-definitions.js";
import type { ThemeDefinition } from "./types.js";

describe("resolveTheme", () => {
  beforeEach(() => {
    resetThemeCache();
  });

  it("resolves gothic theme for exploration variant", () => {
    const def = BUILTIN_DEFINITIONS["gothic"];
    const resolved = resolveTheme(def, "exploration", "#cc4444");
    expect(resolved.asset.name).toBe("gothic");
    expect(resolved.variant).toBe("exploration");
    expect(resolved.keyColor).toBe("#cc4444");
    expect(resolved.swatch.length).toBeGreaterThan(0);
    expect(resolved.colorMap.border).toBe(2);
  });

  it("includes playerPaneFrame on resolved theme", () => {
    const def = BUILTIN_DEFINITIONS["gothic"];
    const resolved = resolveTheme(def, "exploration", "#cc4444");
    expect(resolved.playerPaneFrame).toBeDefined();
    expect(resolved.playerPaneFrame.name).toBe("default");
    expect(Object.keys(resolved.playerPaneFrame.components)).toHaveLength(8);
  });

  it("applies variant overrides for combat", () => {
    const def = BUILTIN_DEFINITIONS["gothic"];
    const resolved = resolveTheme(def, "combat", "#cc4444");
    expect(resolved.colorMap.border).toBe(6);
    expect(resolved.colorMap.corner).toBe(7);
  });

  it("uses default key color when not provided", () => {
    const def = BUILTIN_DEFINITIONS["clean"];
    const resolved = resolveTheme(def, "exploration");
    expect(resolved.keyColor).toBe("#8888aa");
  });

  it("generates valid hex colors in swatch", () => {
    const def = BUILTIN_DEFINITIONS["terminal"];
    const resolved = resolveTheme(def, "exploration", "#00ff88");
    for (const color of resolved.swatch) {
      expect(color.hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("resolves all built-in definitions without error", () => {
    for (const [name, def] of Object.entries(BUILTIN_DEFINITIONS)) {
      const resolved = resolveTheme(def, "exploration", "#888888");
      expect(resolved.asset.name).toBe(name);
    }
  });

  it("variant without override uses base config", () => {
    const def = BUILTIN_DEFINITIONS["clean"];
    // clean has no variant overrides
    const resolved = resolveTheme(def, "combat", "#888888");
    expect(resolved.colorMap.border).toBe(0);
  });

  it("resolves gradient preset from theme definition", () => {
    const def = BUILTIN_DEFINITIONS["gothic"];
    const resolved = resolveTheme(def, "exploration", "#cc4444");
    expect(resolved.gradient).toBeDefined();
    expect(resolved.gradient?.name).toBe("vignette");
  });

  it("theme without gradient config resolves to undefined gradient", () => {
    const def: ThemeDefinition = {
      assetName: "gothic",
      swatchConfig: { preset: "ember", harmony: "analogous" },
      colorMap: { border: 2, corner: 3, separator: 4, title: 5, turnIndicator: 6, sideFrame: 1 },
      // no gradient
    };
    const resolved = resolveTheme(def, "exploration", "#888888");
    expect(resolved.gradient).toBeUndefined();
  });

  it("variant gradient: null disables gradient", () => {
    const def: ThemeDefinition = {
      assetName: "gothic",
      swatchConfig: { preset: "ember", harmony: "analogous" },
      colorMap: { border: 2, corner: 3, separator: 4, title: 5, turnIndicator: 6, sideFrame: 1 },
      gradient: { preset: "vignette" },
      variants: {
        combat: { gradient: null },
      },
    };
    const resolved = resolveTheme(def, "combat", "#888888");
    expect(resolved.gradient).toBeUndefined();
  });

  it("unknown gradient preset name resolves to undefined", () => {
    const def: ThemeDefinition = {
      assetName: "gothic",
      swatchConfig: { preset: "ember", harmony: "analogous" },
      colorMap: { border: 2, corner: 3, separator: 4, title: 5, turnIndicator: 6, sideFrame: 1 },
      gradient: { preset: "nonexistent-gradient-12345" },
    };
    const resolved = resolveTheme(def, "exploration", "#888888");
    expect(resolved.gradient).toBeUndefined();
  });
});
