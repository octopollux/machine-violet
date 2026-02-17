import { describe, it, expect } from "vitest";
import { parseFormatting, toPlainText } from "./formatting.js";
import type { FormattingTag } from "../types/tui.js";

describe("parseFormatting", () => {
  it("returns plain text as-is", () => {
    const result = parseFormatting("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("parses bold tags", () => {
    const result = parseFormatting("This is <b>bold</b> text");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("This is ");
    expect((result[1] as FormattingTag).type).toBe("bold");
    expect((result[1] as FormattingTag).content).toEqual(["bold"]);
    expect(result[2]).toBe(" text");
  });

  it("parses italic tags", () => {
    const result = parseFormatting("<i>italic</i>");
    expect(result).toHaveLength(1);
    expect((result[0] as FormattingTag).type).toBe("italic");
  });

  it("parses underline tags", () => {
    const result = parseFormatting("<u>underlined</u>");
    expect((result[0] as FormattingTag).type).toBe("underline");
  });

  it("parses center tags", () => {
    const result = parseFormatting("<center>centered text</center>");
    expect((result[0] as FormattingTag).type).toBe("center");
  });

  it("parses right tags", () => {
    const result = parseFormatting("<right>right-aligned</right>");
    expect((result[0] as FormattingTag).type).toBe("right");
  });

  it("parses color tags with hex", () => {
    const result = parseFormatting("<color=#cc0000>red text</color>");
    expect(result).toHaveLength(1);
    const tag = result[0] as FormattingTag;
    expect(tag.type).toBe("color");
    expect((tag as Extract<FormattingTag, { type: "color" }>).color).toBe("#cc0000");
    expect(tag.content).toEqual(["red text"]);
  });

  it("parses color with short hex", () => {
    const result = parseFormatting("<color=#f00>red</color>");
    const tag = result[0] as FormattingTag;
    expect(tag.type).toBe("color");
  });

  it("handles nested tags", () => {
    const result = parseFormatting("<b><i>bold italic</i></b>");
    expect(result).toHaveLength(1);
    const bold = result[0] as FormattingTag;
    expect(bold.type).toBe("bold");
    expect(bold.content).toHaveLength(1);
    const italic = bold.content[0] as FormattingTag;
    expect(italic.type).toBe("italic");
    expect(italic.content).toEqual(["bold italic"]);
  });

  it("handles multiple tags at same level", () => {
    const result = parseFormatting("<b>bold</b> and <i>italic</i>");
    expect(result).toHaveLength(3);
    expect((result[0] as FormattingTag).type).toBe("bold");
    expect(result[1]).toBe(" and ");
    expect((result[2] as FormattingTag).type).toBe("italic");
  });

  it("treats unclosed tags as plain text", () => {
    const result = parseFormatting("before <b>unclosed");
    expect(result).toEqual(["before <b>unclosed"]);
  });

  it("treats unrecognized tags as plain text", () => {
    const result = parseFormatting("<blink>flashing</blink>");
    // <blink> isn't recognized, so < is treated as text
    expect(toPlainText(result)).toBe("<blink>flashing</blink>");
  });

  it("handles empty content between tags", () => {
    const result = parseFormatting("<b></b>");
    expect(result).toHaveLength(1);
    expect((result[0] as FormattingTag).content).toEqual([]);
  });

  it("handles text with no tags", () => {
    const result = parseFormatting("Just plain text, nothing special.");
    expect(result).toEqual(["Just plain text, nothing special."]);
  });

  it("handles empty string", () => {
    expect(parseFormatting("")).toEqual([]);
  });

  it("handles angle brackets that aren't tags", () => {
    const result = parseFormatting("3 < 5 and 7 > 2");
    // These should be treated as plain text
    expect(toPlainText(result)).toBe("3 < 5 and 7 > 2");
  });

  it("handles deeply nested tags", () => {
    const result = parseFormatting("<b><i><u>deep</u></i></b>");
    const bold = result[0] as FormattingTag;
    const italic = bold.content[0] as FormattingTag;
    const underline = italic.content[0] as FormattingTag;
    expect(underline.type).toBe("underline");
    expect(underline.content).toEqual(["deep"]);
  });
});

describe("toPlainText", () => {
  it("strips all formatting", () => {
    const nodes = parseFormatting(
      "<b>Bold</b> and <color=#cc0000>colored</color> text",
    );
    expect(toPlainText(nodes)).toBe("Bold and colored text");
  });

  it("handles nested tags", () => {
    const nodes = parseFormatting("<b><i>nested</i></b>");
    expect(toPlainText(nodes)).toBe("nested");
  });

  it("returns plain text unchanged", () => {
    const nodes = parseFormatting("plain text");
    expect(toPlainText(nodes)).toBe("plain text");
  });

  it("handles empty input", () => {
    expect(toPlainText([])).toBe("");
  });
});
