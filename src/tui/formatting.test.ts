import { describe, it, expect } from "vitest";
import { parseFormatting, toPlainText, highlightQuotesWithState, computeQuoteState, healTagBoundaries, scanTagChanges, markdownToTags, padAlignmentLines, visibleLength, wrapLine, wrapAndHealLines } from "./formatting.js";
import type { FormattingTag, NarrativeLine } from "../types/tui.js";

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
    const lines: NarrativeLine[] = [
      { kind: "dm", text: 'The wizard said "Beware' },
      { kind: "dm", text: "the darkness that" },
      { kind: "dm", text: 'lurks within." Then silence.' },
    ];
    const states = computeQuoteState(lines);
    // After line 0: inQuote=true (one open quote)
    expect(states[0]).toBe(true);
    // After line 1: still true (no quotes)
    expect(states[1]).toBe(true);
    // After line 2: false (closing quote)
    expect(states[2]).toBe(false);

    // Now highlight line 1 (middle line, entirely inside quote)
    const nodes1 = parseFormatting(lines[1].text);
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

  it("threads state across color tag inside quotes (no inversion)", () => {
    // Quote spans across a DM color tag: "beware <color=#ff0000>the darkness</color> within"
    const nodes = parseFormatting(
      'He said "beware <color=#ff0000>the darkness</color> within" softly.',
    );
    const result = highlightQuotesWithState(nodes, color, false);
    const plain = toPlainText(result);
    expect(plain).toBe('He said "beware the darkness within" softly.');

    // "He said " should be plain (not highlighted)
    expect(result[0]).toBe("He said ");

    // The opening quote segment should be highlighted
    const openQuote = result[1] as FormattingTag;
    expect(openQuote.type).toBe("color");
    expect(openQuote.color).toBe(color);

    // " softly." at the end should be plain (not highlighted)
    const last = result[result.length - 1];
    expect(typeof last).toBe("string");
    expect(last).toBe(" softly.");
  });

  it("quote opening inside italic carries to next sibling", () => {
    // Quote opens inside <i> and closes outside: <i>"hello</i> world"
    const nodes = parseFormatting('<i>"hello</i> world"');
    const result = highlightQuotesWithState(nodes, color, false);
    const plain = toPlainText(result);
    expect(plain).toBe('"hello world"');

    // " world" (before closing quote) must be highlighted, not plain
    // Find the string or color node containing " world"
    const worldNode = result.find(
      (n) => typeof n !== "string" && n.type === "color" && toPlainText(n.content).includes(" world"),
    );
    expect(worldNode).toBeDefined();
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
  const dm = (text: string): NarrativeLine => ({ kind: "dm", text });

  it("inserts blank line before centered line when preceded by non-empty", () => {
    const result = padAlignmentLines([dm("Some text"), dm("<center>Title</center>")]);
    expect(result).toEqual([dm("Some text"), dm(""), dm("<center>Title</center>")]);
  });

  it("inserts blank line after centered line when followed by non-empty", () => {
    const result = padAlignmentLines([dm("<center>Title</center>"), dm("Some text")]);
    expect(result).toEqual([dm("<center>Title</center>"), dm(""), dm("Some text")]);
  });

  it("inserts blank lines both before and after", () => {
    const result = padAlignmentLines([dm("Before"), dm("<center>Title</center>"), dm("After")]);
    expect(result).toEqual([dm("Before"), dm(""), dm("<center>Title</center>"), dm(""), dm("After")]);
  });

  it("works for <right> tags", () => {
    const result = padAlignmentLines([dm("Before"), dm("<right>— Author</right>"), dm("After")]);
    expect(result).toEqual([dm("Before"), dm(""), dm("<right>— Author</right>"), dm(""), dm("After")]);
  });

  it("does not double-pad when blank line already present before", () => {
    const result = padAlignmentLines([dm("Some text"), dm(""), dm("<center>Title</center>")]);
    expect(result).toEqual([dm("Some text"), dm(""), dm("<center>Title</center>")]);
  });

  it("does not double-pad when blank line already present after", () => {
    const result = padAlignmentLines([dm("<center>Title</center>"), dm(""), dm("Some text")]);
    expect(result).toEqual([dm("<center>Title</center>"), dm(""), dm("Some text")]);
  });

  it("handles center line at start of array", () => {
    const result = padAlignmentLines([dm("<center>Title</center>"), dm("After")]);
    expect(result).toEqual([dm("<center>Title</center>"), dm(""), dm("After")]);
  });

  it("handles center line at end of array", () => {
    const result = padAlignmentLines([dm("Before"), dm("<center>Title</center>")]);
    expect(result).toEqual([dm("Before"), dm(""), dm("<center>Title</center>")]);
  });

  it("handles consecutive center lines", () => {
    const result = padAlignmentLines([
      dm("Before"),
      dm("<center>Title</center>"),
      dm("<center>Subtitle</center>"),
      dm("After"),
    ]);
    expect(result).toEqual([
      dm("Before"),
      dm(""),
      dm("<center>Title</center>"),
      dm(""),
      dm("<center>Subtitle</center>"),
      dm(""),
      dm("After"),
    ]);
  });

  it("passes through lines with no alignment tags unchanged", () => {
    const input: NarrativeLine[] = [dm("Hello"), dm("World"), dm("")];
    expect(padAlignmentLines(input)).toEqual(input);
  });

  it("handles empty array", () => {
    expect(padAlignmentLines([])).toEqual([]);
  });

  it("handles center with leading/trailing whitespace", () => {
    const result = padAlignmentLines([dm("Before"), dm("  <center>Title</center>  "), dm("After")]);
    expect(result).toEqual([dm("Before"), dm(""), dm("  <center>Title</center>  "), dm(""), dm("After")]);
  });
});

describe("visibleLength", () => {
  it("counts plain text characters", () => {
    expect(visibleLength("hello world")).toBe(11);
  });

  it("skips bold tags", () => {
    expect(visibleLength("<b>bold</b>")).toBe(4);
  });

  it("skips italic tags", () => {
    expect(visibleLength("<i>italic</i>")).toBe(6);
  });

  it("skips color tags", () => {
    expect(visibleLength("<color=#ff0000>red text</color>")).toBe(8);
  });

  it("skips nested tags", () => {
    expect(visibleLength("<b><i>nested</i></b>")).toBe(6);
  });

  it("treats unrecognized < as visible", () => {
    expect(visibleLength("3 < 5")).toBe(5);
  });

  it("returns 0 for empty string", () => {
    expect(visibleLength("")).toBe(0);
  });

  it("handles mixed tags and text", () => {
    expect(visibleLength("Hello <b>world</b>!")).toBe(12);
  });
});

describe("wrapLine", () => {
  it("returns short line unchanged", () => {
    expect(wrapLine("hello", 80)).toEqual(["hello"]);
  });

  it("wraps at word boundary", () => {
    const result = wrapLine("hello world", 6);
    expect(result).toEqual(["hello", "world"]);
  });

  it("wraps long text into multiple lines", () => {
    const result = wrapLine("aaa bbb ccc ddd", 8);
    expect(result).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("handles hard break (single word exceeds width)", () => {
    const result = wrapLine("abcdefghij", 5);
    // Word exceeds width but can't split cleanly — goes through as-is
    expect(result).toEqual(["abcdefghij"]);
  });

  it("skips tags when counting width", () => {
    // "<b>hello</b> world" = 11 visible chars; with width=12 it fits
    expect(wrapLine("<b>hello</b> world", 12)).toEqual(["<b>hello</b> world"]);
  });

  it("wraps tag-containing text correctly", () => {
    // "<b>hello</b> world foo" = 15 visible; width=10 should wrap
    // "hello " = 6 vis, "world " = 6 vis → 12 > 10, so "world" goes to next line
    const result = wrapLine("<b>hello</b> world foo", 10);
    expect(result).toEqual(["<b>hello</b>", "world foo"]);
  });

  it("does not wrap alignment lines", () => {
    const line = "<center>This is a very long centered title that exceeds width</center>";
    expect(wrapLine(line, 20)).toEqual([line]);
  });

  it("returns line unchanged when width is 0", () => {
    expect(wrapLine("hello world", 0)).toEqual(["hello world"]);
  });

  it("handles empty string", () => {
    expect(wrapLine("", 80)).toEqual([""]);
  });
});

describe("wrapAndHealLines", () => {
  const dm = (text: string): NarrativeLine => ({ kind: "dm", text });

  it("resets color at source line boundary", () => {
    const result = wrapAndHealLines([
      dm("<color=#ff0000>red text"),
      dm("next line"),
    ], 80);
    // First line gets closed; second line should NOT inherit color
    expect(result).toEqual([
      dm("<color=#ff0000>red text</color>"),
      dm("next line"),
    ]);
  });

  it("carries color across wrap boundary within same source line", () => {
    // Source line with color that wraps — color should persist across the wrap
    const result = wrapAndHealLines([
      dm("<color=#ff0000>aaa bbb ccc</color>"),
    ], 8);
    // Wraps into visual lines; color heals across wrap boundaries
    expect(result).toEqual([
      dm("<color=#ff0000>aaa bbb</color>"),
      dm("<color=#ff0000>ccc</color>"),
    ]);
  });

  it("b/i/u persist across source boundaries", () => {
    const result = wrapAndHealLines([
      dm("<i>italic start"),
      dm("still italic</i>"),
    ], 80);
    expect(result).toEqual([
      dm("<i>italic start</i>"),
      dm("<i>still italic</i>"),
    ]);
  });

  it("b persists but color resets at source boundary", () => {
    const result = wrapAndHealLines([
      dm("<b><color=#ff0000>bold red"),
      dm("next line</b>"),
    ], 80);
    // b should persist, color should reset
    expect(result).toEqual([
      dm("<b><color=#ff0000>bold red</color></b>"),
      dm("<b>next line</b>"),
    ]);
  });

  it("handles lines with no tags", () => {
    const result = wrapAndHealLines([dm("plain line"), dm("another line")], 80);
    expect(result).toEqual([dm("plain line"), dm("another line")]);
  });

  it("handles empty lines array", () => {
    expect(wrapAndHealLines([], 80)).toEqual([]);
  });

  it("handles width 0 (no wrapping, still heals)", () => {
    const result = wrapAndHealLines([
      dm("<i>italic"),
      dm("continued</i>"),
    ], 0);
    expect(result).toEqual([
      dm("<i>italic</i>"),
      dm("<i>continued</i>"),
    ]);
  });

  it("color does not leak across multiple source lines", () => {
    const result = wrapAndHealLines([
      dm("<color=#ff0000>red</color>"),
      dm("normal"),
      dm("<color=#00ff00>green"),
      dm("should not be green"),
    ], 80);
    expect(result).toEqual([
      dm("<color=#ff0000>red</color>"),
      dm("normal"),
      dm("<color=#00ff00>green</color>"),
      dm("should not be green"),
    ]);
  });
});

describe("typed NarrativeLine pipeline", () => {
  it("dev lines with JSON quotes do not corrupt quote state", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: 'He said "hello' },
      { kind: "dev", text: '[dev] tool:read → {"name":"value"}' },
      { kind: "dm", text: 'world"' },
    ];
    const states = computeQuoteState(lines);
    expect(states[0]).toBe(true);
    expect(states[1]).toBe(true);  // dev line ignored, state unchanged
    expect(states[2]).toBe(false); // dm line closes quote
  });

  it("dev lines with formatting tags do not corrupt heal state", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "<i>italic start" },
      { kind: "dev", text: "[dev] tool:read → <b>unclosed" },
      { kind: "dm", text: "still italic</i>" },
    ];
    const result = wrapAndHealLines(lines, 80);
    expect(result[0]).toEqual({ kind: "dm", text: "<i>italic start</i>" });
    expect(result[1]).toEqual({ kind: "dev", text: "[dev] tool:read → <b>unclosed" });
    expect(result[2]).toEqual({ kind: "dm", text: "<i>still italic</i>" });
  });

  it("non-dm lines preserve their kind through wrapping", () => {
    const lines: NarrativeLine[] = [
      { kind: "system", text: "Welcome to the game." },
      { kind: "dm", text: "<b>bold</b> text" },
      { kind: "player", text: "> Alice: attack" },
    ];
    const result = wrapAndHealLines(lines, 80);
    expect(result[0].kind).toBe("system");
    expect(result[1].kind).toBe("dm");
    expect(result[2].kind).toBe("player");
  });
});
