import { describe, it, expect, beforeEach } from "vitest";
import {
  loadBuiltinTheme,
  listBuiltinThemes,
  loadBuiltinPlayerFrame,
  loadThemeDefinition,
  resetThemeCache,
} from "./loader.js";

describe("loader", () => {
  beforeEach(() => {
    resetThemeCache();
  });

  it("loads gothic theme", () => {
    const asset = loadBuiltinTheme("gothic");
    expect(asset.name).toBe("gothic");
    expect(asset.height).toBe(2);
    expect(asset.components.corner_tl.rows).toHaveLength(2);
  });

  it("loads arcane theme", () => {
    const asset = loadBuiltinTheme("arcane");
    expect(asset.name).toBe("arcane");
    expect(asset.height).toBe(2);
  });

  it("loads terminal theme", () => {
    const asset = loadBuiltinTheme("terminal");
    expect(asset.name).toBe("terminal");
    expect(asset.height).toBe(1);
  });

  it("loads clean theme", () => {
    const asset = loadBuiltinTheme("clean");
    expect(asset.name).toBe("clean");
    expect(asset.height).toBe(1);
  });

  it("caches on repeated loads", () => {
    const a = loadBuiltinTheme("gothic");
    const b = loadBuiltinTheme("gothic");
    expect(a).toBe(b); // Same reference
  });

  it("throws on unknown theme", () => {
    expect(() => loadBuiltinTheme("nonexistent")).toThrow();
  });

  it("lists all built-in themes", () => {
    const themes = listBuiltinThemes();
    expect(themes).toContain("gothic");
    expect(themes).toContain("arcane");
    expect(themes).toContain("terminal");
    expect(themes).toContain("clean");
    expect(themes).toHaveLength(4);
  });

  it("resetThemeCache clears cache", () => {
    const a = loadBuiltinTheme("gothic");
    resetThemeCache();
    const b = loadBuiltinTheme("gothic");
    expect(a).not.toBe(b); // Different references after cache clear
    expect(a.name).toBe(b.name); // But same content
  });
});

describe("loadBuiltinPlayerFrame", () => {
  beforeEach(() => {
    resetThemeCache();
  });

  it("loads default player frame", () => {
    const frame = loadBuiltinPlayerFrame("default");
    expect(frame.name).toBe("default");
    expect(Object.keys(frame.components)).toHaveLength(8);
  });

  it("edge components are height 1 (defaulted to space)", () => {
    const frame = loadBuiltinPlayerFrame("default");
    expect(frame.components.edge_left.height).toBe(1);
    expect(frame.components.edge_right.height).toBe(1);
  });

  it("caches on repeated loads", () => {
    const a = loadBuiltinPlayerFrame("default");
    const b = loadBuiltinPlayerFrame("default");
    expect(a).toBe(b);
  });

  it("throws on unknown player frame", () => {
    expect(() => loadBuiltinPlayerFrame("nonexistent")).toThrow();
  });

  it("resetThemeCache clears player frame cache", () => {
    const a = loadBuiltinPlayerFrame("default");
    resetThemeCache();
    const b = loadBuiltinPlayerFrame("default");
    expect(a).not.toBe(b);
    expect(a.name).toBe(b.name);
  });
});

describe("loadThemeDefinition", () => {
  beforeEach(() => {
    resetThemeCache();
  });

  it("loads gothic theme definition with file-sourced config", () => {
    const def = loadThemeDefinition("gothic");
    expect(def.assetName).toBe("gothic");
    expect(def.swatchConfig.preset).toBe("ember");
    expect(def.swatchConfig.harmony).toBe("analogous");
    expect(def.gradient).toEqual({ preset: "vignette" });
    expect(def.colorMap.border).toBe(2);
    expect(def.colorMap.corner).toBe(3);
  });

  it("loads arcane theme with triadic harmony", () => {
    const def = loadThemeDefinition("arcane");
    expect(def.swatchConfig.preset).toBe("ethereal");
    expect(def.swatchConfig.harmony).toBe("triadic");
    expect(def.gradient).toEqual({ preset: "shimmer" });
  });

  it("loads terminal theme with complementary harmony", () => {
    const def = loadThemeDefinition("terminal");
    expect(def.swatchConfig.preset).toBe("cyberpunk");
    expect(def.swatchConfig.harmony).toBe("complementary");
    expect(def.colorMap.border).toBe(1);
    expect(def.colorMap.sideFrame).toBe(0);
  });

  it("loads clean theme with foliage preset", () => {
    const def = loadThemeDefinition("clean");
    expect(def.swatchConfig.preset).toBe("foliage");
    expect(def.colorMap.border).toBe(0);
    expect(def.colorMap.corner).toBe(0);
    expect(def.colorMap.separator).toBe(0);
  });

  it("includes variant overrides from file", () => {
    const def = loadThemeDefinition("gothic");
    expect(def.variants?.combat).toEqual({
      swatchConfig: { preset: "ember" },
      colorMap: { border: 6, corner: 7 },
      gradient: { preset: "hueShift" },
    });
    expect(def.variants?.ooc).toEqual({
      swatchConfig: { preset: "ethereal" },
      colorMap: { border: 1, corner: 2 },
      gradient: null,
    });
  });

  it("caches on repeated loads", () => {
    const a = loadThemeDefinition("gothic");
    const b = loadThemeDefinition("gothic");
    expect(a).toBe(b);
  });

  it("resetThemeCache clears definition cache", () => {
    const a = loadThemeDefinition("gothic");
    resetThemeCache();
    const b = loadThemeDefinition("gothic");
    expect(a).not.toBe(b);
    expect(a.assetName).toBe(b.assetName);
  });

  it("throws on unknown theme", () => {
    expect(() => loadThemeDefinition("nonexistent")).toThrow();
  });

  it("file config overrides defaults", () => {
    // Terminal has border: 1 and sideFrame: 0 which differ from defaults (2 and 1)
    const def = loadThemeDefinition("terminal");
    expect(def.colorMap.border).toBe(1);
    expect(def.colorMap.sideFrame).toBe(0);
    // But title/turnIndicator should still be present (from file or default)
    expect(def.colorMap.title).toBe(5);
    expect(def.colorMap.turnIndicator).toBe(6);
  });
});
