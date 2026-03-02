import { describe, it, expect } from "vitest";
import {
  parseThemeAsset,
  parsePlayerPaneFrame,
  parseSections,
  parseConfigLines,
  extractThemeConfig,
} from "./parser.js";

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

  it("edges and separators are height-flexible (can be shorter than @height)", () => {
    // height-2 theme with single-row edges and separators
    const theme = TWO_ROW_THEME
      .replace("[edge_top]\n═─\n ·", "[edge_top]\n═─")
      .replace("[edge_bottom]\n ·\n═─", "[edge_bottom]\n═─")
      .replace("[edge_left]\n║\n║", "[edge_left]\n║")
      .replace("[edge_right]\n║\n║", "[edge_right]\n║")
      .replace("[separator_left_top]\n╠═\n║", "[separator_left_top]\n╠═")
      .replace("[separator_right_top]\n═╣\n ║", "[separator_right_top]\n═╣")
      .replace("[separator_left_bottom]\n║\n╠═", "[separator_left_bottom]\n╠═")
      .replace("[separator_right_bottom]\n ║\n═╣", "[separator_right_bottom]\n═╣");
    const asset = parseThemeAsset(theme);
    expect(asset.height).toBe(2);
    expect(asset.components.edge_top.height).toBe(1);
    expect(asset.components.separator_left_top.height).toBe(1);
    expect(asset.components.separator_right_bottom.height).toBe(1);
    // Corners still match @height
    expect(asset.components.corner_tl.height).toBe(2);
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

describe("parseSections — comment stripping", () => {
  it("strips single-line comments", () => {
    const content = `@name: test
<!-- This is a comment -->
@height: 1

[corner_tl]
╔
`;
    const { metadata } = parseSections(content);
    expect(metadata["name"]).toBe("test");
    expect(metadata["height"]).toBe("1");
  });

  it("strips multi-line comments", () => {
    const content = `@name: test
<!--
  This is a
  multi-line comment
-->
@height: 1

[corner_tl]
╔
`;
    const { metadata } = parseSections(content);
    expect(metadata["name"]).toBe("test");
    expect(metadata["height"]).toBe("1");
  });

  it("strips comments inside sections", () => {
    const content = `@name: test
@height: 1

[colors]
preset: ember
<!-- harmony: triadic -->
harmony: analogous

[corner_tl]
╔
`;
    const { sections } = parseSections(content);
    const colorLines = sections.get("colors")!;
    expect(colorLines.join("\n")).not.toContain("triadic");
    expect(colorLines.join("\n")).toContain("analogous");
  });

  it("strips multi-line comments spanning section content", () => {
    const content = `@name: test

<!--
[variant_combat]
preset: cyberpunk
border: 5
-->

[corner_tl]
╔
`;
    const { sections } = parseSections(content);
    expect(sections.has("variant_combat")).toBe(false);
  });

  it("does not include comment content as section rows", () => {
    const content = `@name: test

[colors]
preset: ember
<!-- This should not appear -->
gradient: vignette
`;
    const { sections } = parseSections(content);
    const lines = sections.get("colors")!;
    const joined = lines.join("\n");
    expect(joined).not.toContain("should not appear");
    expect(joined).toContain("preset: ember");
    expect(joined).toContain("gradient: vignette");
  });
});

describe("parseConfigLines", () => {
  it("parses key: value pairs", () => {
    const result = parseConfigLines(["preset: ember", "harmony: analogous"]);
    expect(result).toEqual({ preset: "ember", harmony: "analogous" });
  });

  it("skips blank lines", () => {
    const result = parseConfigLines(["preset: ember", "", "harmony: analogous"]);
    expect(result).toEqual({ preset: "ember", harmony: "analogous" });
  });

  it("skips lines without colons", () => {
    const result = parseConfigLines(["preset: ember", "no colon here", "harmony: analogous"]);
    expect(result).toEqual({ preset: "ember", harmony: "analogous" });
  });

  it("handles leading/trailing whitespace", () => {
    const result = parseConfigLines(["  preset:  ember  ", "  border : 3 "]);
    expect(result).toEqual({ preset: "ember", border: "3" });
  });

  it("returns empty object for empty input", () => {
    expect(parseConfigLines([])).toEqual({});
  });
});

describe("extractThemeConfig", () => {
  it("extracts base colors config from [colors] section", () => {
    const sections = new Map<string, string[]>();
    sections.set("colors", [
      "preset: ember",
      "harmony: analogous",
      "gradient: vignette",
      "border: 2",
      "corner: 3",
      "separator: 4",
      "title: 5",
      "turn_indicator: 6",
      "side_frame: 1",
    ]);

    const config = extractThemeConfig({}, sections);
    expect(config.swatchConfig).toEqual({ preset: "ember", harmony: "analogous" });
    expect(config.colorMap).toEqual({
      border: 2,
      corner: 3,
      separator: 4,
      title: 5,
      turnIndicator: 6,
      sideFrame: 1,
    });
    expect(config.gradient).toEqual({ preset: "vignette" });
  });

  it("handles gradient: none → null", () => {
    const sections = new Map<string, string[]>();
    sections.set("colors", ["gradient: none"]);

    const config = extractThemeConfig({}, sections);
    expect(config.gradient).toBeNull();
  });

  it("extracts variant overrides from [variant_*] sections", () => {
    const sections = new Map<string, string[]>();
    sections.set("variant_combat", [
      "preset: ember",
      "border: 6",
      "corner: 7",
      "gradient: hueShift",
    ]);
    sections.set("variant_ooc", [
      "preset: ethereal",
      "border: 1",
      "corner: 2",
      "gradient: none",
    ]);

    const config = extractThemeConfig({}, sections);
    expect(config.variants?.combat).toEqual({
      swatchConfig: { preset: "ember" },
      colorMap: { border: 6, corner: 7 },
      gradient: { preset: "hueShift" },
    });
    expect(config.variants?.ooc).toEqual({
      swatchConfig: { preset: "ethereal" },
      colorMap: { border: 1, corner: 2 },
      gradient: null,
    });
  });

  it("returns empty config when no [colors] or [variant_*] present", () => {
    const sections = new Map<string, string[]>();
    sections.set("corner_tl", ["╔"]);
    const config = extractThemeConfig({}, sections);
    expect(config.swatchConfig).toBeUndefined();
    expect(config.colorMap).toBeUndefined();
    expect(config.gradient).toBeUndefined();
    expect(config.variants).toBeUndefined();
  });

  it("extracts @player_frame from metadata", () => {
    const config = extractThemeConfig({ player_frame: "ornate" }, new Map());
    expect(config.playerFrameName).toBe("ornate");
  });

  it("partial color map (only some indices)", () => {
    const sections = new Map<string, string[]>();
    sections.set("colors", ["border: 0", "corner: 0"]);
    const config = extractThemeConfig({}, sections);
    expect(config.colorMap).toEqual({ border: 0, corner: 0 });
  });
});

describe("parseThemeAsset with config sections", () => {
  const THEME_WITH_CONFIG = `@name: test
@genre_tags: fantasy
@height: 1

[colors]
preset: ember
harmony: analogous
gradient: vignette
border: 2

[variant_combat]
preset: cyberpunk
border: 6

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

  it("parses theme with config sections without errors", () => {
    const asset = parseThemeAsset(THEME_WITH_CONFIG);
    expect(asset.name).toBe("test");
    expect(asset.height).toBe(1);
    expect(Object.keys(asset.components)).toHaveLength(13);
  });

  it("config sections do not appear as components", () => {
    const asset = parseThemeAsset(THEME_WITH_CONFIG);
    expect((asset.components as Record<string, unknown>)["colors"]).toBeUndefined();
    expect((asset.components as Record<string, unknown>)["variant_combat"]).toBeUndefined();
  });

  it("accepts pre-parsed ParsedSections", () => {
    const parsed = parseSections(THEME_WITH_CONFIG);
    const asset = parseThemeAsset(parsed);
    expect(asset.name).toBe("test");
    expect(asset.components.corner_tl.rows).toEqual(["╔"]);
  });

  it("theme with comments + config parses cleanly", () => {
    const content = `<!-- Test Theme -->
@name: commented
@height: 1

[colors]
<!-- Base palette -->
preset: ember

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
    const asset = parseThemeAsset(content);
    expect(asset.name).toBe("commented");
    expect(Object.keys(asset.components)).toHaveLength(13);
  });
});
