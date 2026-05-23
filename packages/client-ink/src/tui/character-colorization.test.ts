import { describe, it, expect, beforeEach } from "vitest";
import type { FormattingTag } from "@machine-violet/shared/types/tui.js";
import {
  colorizeSheetLines,
  parseFrontMatterLines,
} from "./character-colorization.js";
import { toPlainText } from "./formatting.js";
import { resolveTheme } from "./themes/resolver.js";
import { resetThemeCache } from "./themes/loader.js";
import { BUILTIN_DEFINITIONS } from "./themes/builtin-definitions.js";

let theme: ReturnType<typeof resolveTheme>;

beforeEach(() => {
  resetThemeCache();
  theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
});

describe("parseFrontMatterLines", () => {
  it("extracts **Key:** Value lines under the H1", () => {
    const fm = parseFrontMatterLines(
      ["# Aldric", "**Type:** character", "**Color:** #aa3333", "", "Body."].join("\n"),
    );
    expect(fm.type).toBe("character");
    expect(fm.color).toBe("#aa3333");
  });

  it("treats <none> as explicit null", () => {
    const fm = parseFrontMatterLines(["# X", "**Class:** <none>"].join("\n"));
    expect(fm.class).toBeNull();
  });

  it("snake_cases multi-word keys", () => {
    const fm = parseFrontMatterLines(
      ["# X", "**Display Resources:** HP, Spell Slots"].join("\n"),
    );
    expect(fm.display_resources).toBe("HP, Spell Slots");
  });
});

describe("colorizeSheetLines", () => {
  it("wraps ## headings in a colored bold tag", () => {
    const [nodes] = colorizeSheetLines(["## Stats"], {
      theme,
      frameAnchor: 1,
      wikilinks: "preserve",
    });
    const outer = nodes[0] as Extract<FormattingTag, { type: "color" }>;
    expect(outer.type).toBe("color");
    const inner = outer.content[0] as FormattingTag;
    expect(inner.type).toBe("bold");
    expect(toPlainText(inner.content)).toBe("Stats");
  });

  it("colorizes the key span of **Key:** Value lines", () => {
    const [nodes] = colorizeSheetLines(["**HP:** 34/42"], {
      theme,
      frameAnchor: 0,
      wikilinks: "preserve",
    });
    // First node is the colored bold key span.
    const keyColor = nodes[0] as Extract<FormattingTag, { type: "color" }>;
    expect(keyColor.type).toBe("color");
    const keyBold = keyColor.content[0] as FormattingTag;
    expect(keyBold.type).toBe("bold");
    expect(toPlainText(keyBold.content)).toBe("HP:");
    // Value text follows after the space.
    expect(toPlainText(nodes)).toBe("HP: 34/42");
  });

  it("preserves wikilink targets via the wikilink AST tag", () => {
    const [nodes] = colorizeSheetLines(["See [[Aldric Mossback]] here."], {
      theme,
      frameAnchor: 1,
      wikilinks: "preserve",
    });
    // Walk to the wikilink node.
    const found = findWikilink(nodes);
    expect(found).not.toBeNull();
    expect(found!.target).toBe("aldric-mossback");
    expect(toPlainText(found!.content)).toBe("Aldric Mossback");
    // Visible text drops the brackets.
    expect(toPlainText(nodes)).toBe("See Aldric Mossback here.");
  });

  it("strips wikilink brackets without preserving target when wikilinks=strip", () => {
    const [nodes] = colorizeSheetLines(["See [[Aldric Mossback]] here."], {
      theme,
      frameAnchor: 0,
      wikilinks: "strip",
    });
    expect(findWikilink(nodes)).toBeNull();
    expect(toPlainText(nodes)).toBe("See Aldric Mossback here.");
  });

  it("uses front-matter color for entity hue when present", () => {
    const [nodes] = colorizeSheetLines(["See [[Foo]]."], {
      theme,
      frameAnchor: 1,
      frontMatter: { color: "#abcdef" },
      wikilinks: "preserve",
    });
    const wl = findWikilink(nodes);
    expect(wl).not.toBeNull();
    // Wikilink content is wrapped in a color tag carrying the entity hue.
    const colorTag = wl!.content[0] as FormattingTag;
    expect(colorTag.type).toBe("color");
    expect((colorTag as Extract<FormattingTag, { type: "color" }>).color).toBe("#abcdef");
  });

  it("falls back to theme key color when no entity hue front matter", () => {
    const [nodes] = colorizeSheetLines(["See [[Foo]]."], {
      theme,
      frameAnchor: 1,
      wikilinks: "preserve",
    });
    const wl = findWikilink(nodes);
    const colorTag = wl!.content[0] as Extract<FormattingTag, { type: "color" }>;
    expect(colorTag.color).toBe(theme.keyColor);
  });

  it("colorizes bare hex strings in front-matter values", () => {
    const [nodes] = colorizeSheetLines(["**Color:** #cc4444"], {
      theme,
      frameAnchor: 1,
      wikilinks: "preserve",
    });
    // The hex value gets its own color tag (passes through colorizeHexStrings).
    const flat = JSON.stringify(nodes);
    expect(flat).toContain('"color":"#cc4444"');
  });

  it("handles a wikilink inside a heading", () => {
    const [nodes] = colorizeSheetLines(["## [[Aldric]]'s Stats"], {
      theme,
      frameAnchor: 1,
      wikilinks: "preserve",
    });
    const wl = findWikilink(nodes);
    expect(wl).not.toBeNull();
    expect(wl!.target).toBe("aldric");
    expect(toPlainText(nodes)).toBe("Aldric's Stats");
  });

  it("handles a wikilink in a front-matter value", () => {
    const [nodes] = colorizeSheetLines(["**Location:** [[The Crooked Tankard]]"], {
      theme,
      frameAnchor: 1,
      wikilinks: "preserve",
    });
    const wl = findWikilink(nodes);
    expect(wl).not.toBeNull();
    // slugify strips the leading "The" article.
    expect(wl!.target).toBe("crooked-tankard");
  });

  it("anchor choice differs between frameAnchor 0 and 1", () => {
    const [a] = colorizeSheetLines(["## Stats"], { theme, frameAnchor: 0, wikilinks: "strip" });
    const [b] = colorizeSheetLines(["## Stats"], { theme, frameAnchor: 1, wikilinks: "strip" });
    const colorA = (a[0] as Extract<FormattingTag, { type: "color" }>).color;
    const colorB = (b[0] as Extract<FormattingTag, { type: "color" }>).color;
    expect(colorA).not.toBe(colorB);
  });
});

// Recursively find the first wikilink tag in a node tree.
function findWikilink(
  nodes: import("@machine-violet/shared/types/tui.js").FormattingNode[],
): Extract<FormattingTag, { type: "wikilink" }> | null {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (n.type === "wikilink") return n;
    const inner = findWikilink(n.content);
    if (inner) return inner;
  }
  return null;
}
