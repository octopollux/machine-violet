import { describe, it, expect } from "vitest";
import { parseFormatting, toPlainText, highlightQuotesWithState, computeQuoteState, healTagBoundaries, scanTagChanges, markdownToTags, padAlignmentLines } from "./formatting.js";
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

describe("highlightQuotesWithState", () => {
  const color = "#ffffff";

  it("highlights a single-line quote", () => {
    const nodes = parseFormatting('He said "hello" quietly.');
    const result = highlightQuotesWithState(nodes, color, false);
    // Should produce: 'He said ', color('"hello"'), ' quietly.'
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("He said ");
    const quoted = result[1] as FormattingTag;
    expect(quoted.type).toBe("color");
    expect(quoted.color).toBe(color);
    expect(quoted.content).toEqual(['"hello"']);
    expect(result[2]).toBe(" quietly.");
  });

  it("threads quote state across multiple nodes (multiline)", () => {
    // Simulate 3 lines where a quote spans from line 1 into line 3
    const lines = [
      'The wizard said "Beware',
      "the darkness that",
      'lurks within." Then silence.',
    ];
    const states = computeQuoteState(lines);
    // After line 0: inQuote=true (one open quote)
    expect(states[0]).toBe(true);
    // After line 1: still true (no quotes)
    expect(states[1]).toBe(true);
    // After line 2: false (closing quote)
    expect(states[2]).toBe(false);

    // Now highlight line 1 (middle line, entirely inside quote)
    const nodes1 = parseFormatting(lines[1]);
    const result1 = highlightQuotesWithState(nodes1, color, true);
    // Entire text should be wrapped in a color node (mid-quote)
    expect(result1).toHaveLength(1);
    const tag = result1[0] as FormattingTag;
    expect(tag.type).toBe("color");
    expect(tag.color).toBe(color);
  });

  it("threads state across formatting tags", () => {
    // Quote starts before bold tag and ends after it: "hello <b>world</b> end"
    const nodes = parseFormatting('"hello <b>world</b> end"');
    const result = highlightQuotesWithState(nodes, color, false);
    // The open " starts a quote; the bold tag content is inside it; the closing " ends it
    const plain = toPlainText(result);
    expect(plain).toBe('"hello world end"');
    // First node should be a color node for the opening part
    const first = result[0] as FormattingTag;
    expect(first.type).toBe("color");
  });
});

describe("scanTagChanges", () => {
  it("detects open and close tags", () => {
    const changes = scanTagChanges("<b>hello</b>");
    expect(changes).toEqual([
      { kind: "open", name: "b", raw: "<b>" },
      { kind: "close", name: "b", raw: "</b>" },
    ]);
  });

  it("detects color tags", () => {
    const changes = scanTagChanges("<color=#ff0000>red</color>");
    expect(changes).toEqual([
      { kind: "open", name: "color", raw: "<color=#ff0000>" },
      { kind: "close", name: "color", raw: "</color>" },
    ]);
  });

  it("returns empty for plain text", () => {
    expect(scanTagChanges("no tags here")).toEqual([]);
  });

  it("handles unclosed tags", () => {
    const changes = scanTagChanges("<i>hello");
    expect(changes).toEqual([{ kind: "open", name: "i", raw: "<i>" }]);
  });
});

describe("markdownToTags", () => {
  it("converts H1 heading to bold", () => {
    expect(markdownToTags("# Title")).toBe("<b>Title</b>");
  });

  it("converts H2 heading to bold", () => {
    expect(markdownToTags("## Section")).toBe("<b>Section</b>");
  });

  it("converts H3 heading to bold", () => {
    expect(markdownToTags("### Subsection")).toBe("<b>Subsection</b>");
  });

  it("converts **bold** to <b> tags", () => {
    expect(markdownToTags("**Type:** PC")).toBe("<b>Type:</b> PC");
  });

  it("converts *italic* to <i> tags", () => {
    expect(markdownToTags("*whispers softly*")).toBe("<i>whispers softly</i>");
  });

  it("does not confuse ** with *", () => {
    expect(markdownToTags("**bold** and *italic*")).toBe("<b>bold</b> and <i>italic</i>");
  });

  it("strips links to display text", () => {
    expect(markdownToTags("[Aldric](entities/aldric.md)")).toBe("Aldric");
  });

  it("converts list items to visual bullets", () => {
    expect(markdownToTags("- Sword of Light")).toBe("  · Sword of Light");
  });

  it("preserves indented list items", () => {
    expect(markdownToTags("  - Sub item")).toBe("    · Sub item");
  });

  it("passes plain text through unchanged", () => {
    expect(markdownToTags("Just plain text.")).toBe("Just plain text.");
  });

  it("passes empty string through unchanged", () => {
    expect(markdownToTags("")).toBe("");
  });

  it("handles multiple bold spans on one line", () => {
    expect(markdownToTags("**HP:** 42 **AC:** 16")).toBe("<b>HP:</b> 42 <b>AC:</b> 16");
  });

  it("handles links within other content", () => {
    expect(markdownToTags("Allies: [Bran](bran.md) and [Cara](cara.md)"))
      .toBe("Allies: Bran and Cara");
  });
});

describe("healTagBoundaries", () => {
  it("heals italic spanning two lines", () => {
    const result = healTagBoundaries(["<i>hello", "world</i>"]);
    expect(result).toEqual(["<i>hello</i>", "<i>world</i>"]);
  });

  it("heals italic spanning three lines", () => {
    const result = healTagBoundaries([
      "<i>The door creaked open,",
      "revealing ancient horrors.",
      "She screamed.</i> The end.",
    ]);
    expect(result).toEqual([
      "<i>The door creaked open,</i>",
      "<i>revealing ancient horrors.</i>",
      "<i>She screamed.</i> The end.",
    ]);
  });

  it("heals nested bold+italic spanning two lines", () => {
    const result = healTagBoundaries(["<b><i>hello", "world</i></b>"]);
    expect(result).toEqual(["<b><i>hello</i></b>", "<b><i>world</i></b>"]);
  });

  it("passes through lines with no tags unchanged", () => {
    const input = ["plain line one", "plain line two"];
    expect(healTagBoundaries(input)).toEqual(input);
  });

  it("passes through lines with self-contained tags unchanged", () => {
    const input = ["<b>bold</b> text", "normal"];
    expect(healTagBoundaries(input)).toEqual(input);
  });

  it("handles mixed tagged and plain lines", () => {
    const result = healTagBoundaries([
      "<i>start italic",
      "still italic</i>",
      "plain text",
      "<b>bold text</b>",
    ]);
    expect(result).toEqual([
      "<i>start italic</i>",
      "<i>still italic</i>",
      "plain text",
      "<b>bold text</b>",
    ]);
  });

  it("heals color tags spanning lines", () => {
    const result = healTagBoundaries([
      "<color=#ff0000>red text",
      "more red</color>",
    ]);
    expect(result).toEqual([
      "<color=#ff0000>red text</color>",
      "<color=#ff0000>more red</color>",
    ]);
  });

  it("handles empty lines array", () => {
    expect(healTagBoundaries([])).toEqual([]);
  });

  it("handles empty string lines within open tags", () => {
    const result = healTagBoundaries(["<i>start", "", "end</i>"]);
    expect(result).toEqual(["<i>start</i>", "<i></i>", "<i>end</i>"]);
  });
});

describe("padAlignmentLines", () => {
  it("inserts blank line before centered line when preceded by non-empty", () => {
    const result = padAlignmentLines(["Some text", "<center>Title</center>"]);
    expect(result).toEqual(["Some text", "", "<center>Title</center>"]);
  });

  it("inserts blank line after centered line when followed by non-empty", () => {
    const result = padAlignmentLines(["<center>Title</center>", "Some text"]);
    expect(result).toEqual(["<center>Title</center>", "", "Some text"]);
  });

  it("inserts blank lines both before and after", () => {
    const result = padAlignmentLines(["Before", "<center>Title</center>", "After"]);
    expect(result).toEqual(["Before", "", "<center>Title</center>", "", "After"]);
  });

  it("works for <right> tags", () => {
    const result = padAlignmentLines(["Before", "<right>— Author</right>", "After"]);
    expect(result).toEqual(["Before", "", "<right>— Author</right>", "", "After"]);
  });

  it("does not double-pad when blank line already present before", () => {
    const result = padAlignmentLines(["Some text", "", "<center>Title</center>"]);
    expect(result).toEqual(["Some text", "", "<center>Title</center>"]);
  });

  it("does not double-pad when blank line already present after", () => {
    const result = padAlignmentLines(["<center>Title</center>", "", "Some text"]);
    expect(result).toEqual(["<center>Title</center>", "", "Some text"]);
  });

  it("handles center line at start of array", () => {
    const result = padAlignmentLines(["<center>Title</center>", "After"]);
    expect(result).toEqual(["<center>Title</center>", "", "After"]);
  });

  it("handles center line at end of array", () => {
    const result = padAlignmentLines(["Before", "<center>Title</center>"]);
    expect(result).toEqual(["Before", "", "<center>Title</center>"]);
  });

  it("handles consecutive center lines", () => {
    const result = padAlignmentLines([
      "Before",
      "<center>Title</center>",
      "<center>Subtitle</center>",
      "After",
    ]);
    expect(result).toEqual([
      "Before",
      "",
      "<center>Title</center>",
      "",
      "<center>Subtitle</center>",
      "",
      "After",
    ]);
  });

  it("passes through lines with no alignment tags unchanged", () => {
    const input = ["Hello", "World", ""];
    expect(padAlignmentLines(input)).toEqual(input);
  });

  it("handles empty array", () => {
    expect(padAlignmentLines([])).toEqual([]);
  });

  it("handles center with leading/trailing whitespace", () => {
    const result = padAlignmentLines(["Before", "  <center>Title</center>  ", "After"]);
    expect(result).toEqual(["Before", "", "  <center>Title</center>  ", "", "After"]);
  });
});
