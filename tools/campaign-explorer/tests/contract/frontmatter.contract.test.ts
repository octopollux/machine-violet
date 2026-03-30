/**
 * Contract test: validates that parseFrontMatter() from the main codebase
 * returns the shape the Campaign Explorer's MarkdownViewer expects.
 */
import { describe, it, expect } from "vitest";
import { parseFrontMatter } from "../../../../packages/engine/src/tools/filesystem/frontmatter.js";

describe("parseFrontMatter contract", () => {
  it("returns { frontMatter, body, changelog }", () => {
    const result = parseFrontMatter("# Test\n\n**Race:** Human\n\nBody text here.");
    expect(result).toHaveProperty("frontMatter");
    expect(result).toHaveProperty("body");
    expect(result).toHaveProperty("changelog");
  });

  it("extracts _title from H1", () => {
    const result = parseFrontMatter("# Eldric the Wise\n\n**Class:** Wizard");
    expect(result.frontMatter._title).toBe("Eldric the Wise");
  });

  it("parses **Key:** Value front matter", () => {
    const result = parseFrontMatter(
      "# NPC\n\n**Race:** Elf\n**Class:** Ranger\n\nSome body text.",
    );
    expect(result.frontMatter.race).toBe("Elf");
    expect(result.frontMatter.class).toBe("Ranger");
  });

  it("extracts changelog entries", () => {
    const result = parseFrontMatter(
      "# NPC\n\nBody\n\n## Changelog\n- Added in scene 1\n- Updated in scene 3",
    );
    expect(result.changelog).toEqual(["Added in scene 1", "Updated in scene 3"]);
  });

  it("normalizes keys to lowercase with underscores", () => {
    const result = parseFrontMatter("# X\n\n**Display Name:** Foo");
    expect(result.frontMatter.display_name).toBe("Foo");
  });
});
