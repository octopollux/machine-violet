import { describe, it, expect, beforeEach } from "vitest";
import {
  loadBuiltinTheme,
  listBuiltinThemes,
  loadBuiltinPlayerFrame,
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
