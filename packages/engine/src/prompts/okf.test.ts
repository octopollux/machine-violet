import { parseOkf } from "./okf.js";

describe("parseOkf", () => {
  it("parses frontmatter scalars (quoted and unquoted) and flow arrays", () => {
    const { frontmatter } = parseOkf(
      `---\ntype: visual-style\ntitle: "Velvia"\nrating: "?"\ntags: [film-stock, photoreal, cool]\nmade-for-model: gpt-image-2\n---\n\n# Style\n\nbody`,
    );
    expect(frontmatter.type).toBe("visual-style");
    expect(frontmatter.title).toBe("Velvia");
    expect(frontmatter.rating).toBe("?");
    expect(frontmatter.tags).toEqual(["film-stock", "photoreal", "cool"]);
    expect(frontmatter["made-for-model"]).toBe("gpt-image-2");
  });

  it("splits the body into `# Heading` sections, trimmed, in file order", () => {
    const { sections } = parseOkf(
      `---\ntype: x\n---\n\n# Direction\n\nfirst para\n\n# Style\n\n\`the style line\`\n\n# Notes\n\nmaintainer note`,
    );
    expect([...sections.keys()]).toEqual(["Direction", "Style", "Notes"]);
    expect(sections.get("Direction")).toBe("first para");
    expect(sections.get("Style")).toBe("`the style line`");
    expect(sections.get("Notes")).toBe("maintainer note");
  });

  it("treats `## ` subheadings as section content, not new top-level sections", () => {
    const { sections } = parseOkf(`# Style\n\nintro\n\n## Sub\n\nnested`);
    expect([...sections.keys()]).toEqual(["Style"]);
    expect(sections.get("Style")).toBe("intro\n\n## Sub\n\nnested");
  });

  it("handles a document with no frontmatter", () => {
    const { frontmatter, sections } = parseOkf(`# Style\n\njust a body`);
    expect(frontmatter).toEqual({});
    expect(sections.get("Style")).toBe("just a body");
  });

  it("normalizes CRLF", () => {
    const { sections } = parseOkf(`# Style\r\n\r\nwin body`);
    expect(sections.get("Style")).toBe("win body");
  });
});
