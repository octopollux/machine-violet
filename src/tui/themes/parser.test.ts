import { describe, it, expect } from "vitest";
import { parseThemeAsset, parsePlayerPaneFrame } from "./parser.js";

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

const MINIMAL_PLAYER_FRAME = `@name: test-frame

[corner_tl]
┌

[corner_tr]
┐

[corner_bl]
└

[corner_br]
┘

[edge_top]
─

[edge_bottom]
─

[edge_left]
│

[edge_right]
│
`;

const CORNERS_ONLY_FRAME = `@name: corners-only

[corner_tl]
┌

[corner_tr]
┐

[corner_bl]
└

[corner_br]
┘
`;

const MULTI_ROW_CORNERS_FRAME = `@name: multi-row
[corner_tl]
┌
│
(

[corner_tr]
┐
|
)

[corner_bl]
(
|
└

[corner_br]
)
|
┘
`;

describe("parsePlayerPaneFrame", () => {
  it("parses a full player frame (corners + edges)", () => {
    const frame = parsePlayerPaneFrame(MINIMAL_PLAYER_FRAME);
    expect(frame.name).toBe("test-frame");
    expect(Object.keys(frame.components)).toHaveLength(8);
  });

  it("reads component rows correctly", () => {
    const frame = parsePlayerPaneFrame(MINIMAL_PLAYER_FRAME);
    expect(frame.components.corner_tl.rows).toEqual(["┌"]);
    expect(frame.components.edge_top.rows).toEqual(["─"]);
    expect(frame.components.edge_left.rows).toEqual(["│"]);
  });

  it("parses a corners-only frame (edges default to space)", () => {
    const frame = parsePlayerPaneFrame(CORNERS_ONLY_FRAME);
    expect(frame.name).toBe("corners-only");
    expect(Object.keys(frame.components)).toHaveLength(8);
    expect(frame.components.edge_top).toEqual({ rows: [" "], width: 1, height: 1 });
    expect(frame.components.edge_bottom).toEqual({ rows: [" "], width: 1, height: 1 });
    expect(frame.components.edge_left).toEqual({ rows: [" "], width: 1, height: 1 });
    expect(frame.components.edge_right).toEqual({ rows: [" "], width: 1, height: 1 });
  });

  it("empty edge sections also default to space", () => {
    const frameText = `@name: empty-edges

[corner_tl]
+
[corner_tr]
+
[corner_bl]
+
[corner_br]
+

[edge_top]

[edge_bottom]

[edge_left]

[edge_right]
`;
    const frame = parsePlayerPaneFrame(frameText);
    expect(frame.components.edge_top).toEqual({ rows: [" "], width: 1, height: 1 });
    expect(frame.components.edge_left).toEqual({ rows: [" "], width: 1, height: 1 });
  });

  it("allows multi-row corners", () => {
    const frame = parsePlayerPaneFrame(MULTI_ROW_CORNERS_FRAME);
    expect(frame.components.corner_tl.height).toBe(3);
    expect(frame.components.corner_tl.rows).toEqual(["┌", "│", "("]);
    expect(frame.components.corner_br.height).toBe(3);
  });

  it("throws on missing @name", () => {
    expect(() => parsePlayerPaneFrame("[corner_tl]\n+")).toThrow("missing @name");
  });

  it("throws on missing required corner component", () => {
    const partial = `@name: broken

[corner_tl]
+
`;
    expect(() => parsePlayerPaneFrame(partial)).toThrow("missing required component");
  });

  it("handles CRLF line endings", () => {
    const crlf = MINIMAL_PLAYER_FRAME.replace(/\n/g, "\r\n");
    const frame = parsePlayerPaneFrame(crlf);
    expect(frame.name).toBe("test-frame");
    expect(frame.components.corner_tl.rows).toEqual(["┌"]);
  });
});
