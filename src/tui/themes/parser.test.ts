import { describe, it, expect } from "vitest";
import { parseThemeAsset } from "./parser.js";

const MINIMAL_THEME = `@name: test
@genre_tags: fantasy, horror
@height: 1

[corner_tl]
╔

[corner_tr]
╗

[corner_bl]
╚

[corner_br]
╝

[edge_top]
═

[edge_bottom]
═

[edge_left]
║

[edge_right]
║

[separator_left_top]
╠

[separator_right_top]
╣

[separator_left_bottom]
╠

[separator_right_bottom]
╣

[turn_separator]
── ◆ ──
`;

const TWO_ROW_THEME = `@name: gothic
@genre_tags: grimdark, horror
@height: 2

[corner_tl]
╔═
║

[corner_tr]
═╗
 ║

[corner_bl]
║
╚═

[corner_br]
 ║
═╝

[edge_top]
═─
 ·

[edge_bottom]
 ·
═─

[edge_left]
║
║

[edge_right]
║
║

[separator_left_top]
╠═
║

[separator_right_top]
═╣
 ║

[separator_left_bottom]
║
╠═

[separator_right_bottom]
 ║
═╣

[turn_separator]
── ◆ ──
`;

describe("parseThemeAsset", () => {
  it("parses a minimal height-1 theme", () => {
    const asset = parseThemeAsset(MINIMAL_THEME);
    expect(asset.name).toBe("test");
    expect(asset.genreTags).toEqual(["fantasy", "horror"]);
    expect(asset.height).toBe(1);
  });

  it("has all required components", () => {
    const asset = parseThemeAsset(MINIMAL_THEME);
    const names = Object.keys(asset.components);
    expect(names).toContain("corner_tl");
    expect(names).toContain("edge_top");
    expect(names).toContain("turn_separator");
    expect(names).toHaveLength(13);
  });

  it("component rows match height", () => {
    const asset = parseThemeAsset(MINIMAL_THEME);
    expect(asset.components.corner_tl.height).toBe(1);
    expect(asset.components.corner_tl.rows).toEqual(["╔"]);
    expect(asset.components.edge_top.rows).toEqual(["═"]);
  });

  it("turn_separator is height-exempt", () => {
    const asset = parseThemeAsset(MINIMAL_THEME);
    expect(asset.components.turn_separator.height).toBe(1);
    expect(asset.components.turn_separator.rows).toEqual(["── ◆ ──"]);
  });

  it("parses a height-2 theme", () => {
    const asset = parseThemeAsset(TWO_ROW_THEME);
    expect(asset.name).toBe("gothic");
    expect(asset.height).toBe(2);
    expect(asset.components.corner_tl.height).toBe(2);
    expect(asset.components.corner_tl.rows).toEqual(["╔═", "║ "]);
  });

  it("pads rows to equal width within a component", () => {
    const asset = parseThemeAsset(TWO_ROW_THEME);
    const tl = asset.components.corner_tl;
    // Both rows should be the same display width
    expect(tl.rows[0].length).toBe(tl.rows[1].length);
  });

  it("throws on missing @name", () => {
    expect(() => parseThemeAsset("@height: 1\n[corner_tl]\n+")).toThrow("missing @name");
  });

  it("throws on missing required component", () => {
    const partial = `@name: broken
@height: 1

[corner_tl]
+
`;
    expect(() => parseThemeAsset(partial)).toThrow("missing required component");
  });

  it("throws on row count mismatch", () => {
    // corner_tl has 1 row but @height is 2
    const bad = TWO_ROW_THEME.replace(
      "[corner_tl]\n╔═\n║",
      "[corner_tl]\n╔═",
    );
    expect(() => parseThemeAsset(bad)).toThrow("row(s), expected 2");
  });

  it("handles CRLF line endings", () => {
    const crlf = MINIMAL_THEME.replace(/\n/g, "\r\n");
    const asset = parseThemeAsset(crlf);
    expect(asset.name).toBe("test");
    expect(asset.components.corner_tl.rows).toEqual(["╔"]);
  });

  it("handles trailing whitespace in sections", () => {
    const asset = parseThemeAsset(MINIMAL_THEME);
    // Should still parse correctly
    expect(asset.components.edge_top.rows[0]).toBe("═");
  });

  it("reports component width", () => {
    const asset = parseThemeAsset(TWO_ROW_THEME);
    expect(asset.components.corner_tl.width).toBe(2);
    expect(asset.components.turn_separator.width).toBe(7);
  });
});
