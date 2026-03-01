import { describe, it, expect } from "vitest";
import { parseFormatting, toPlainText, highlightQuotesWithState, markdownToTags, nodeVisibleLength, wrapNodes, processNarrativeLines } from "./formatting.js";
import type { FormattingTag, FormattingNode, NarrativeLine } from "../types/tui.js";

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
    const quoted = result[1] as { type: "color"; color: string; content: FormattingNode[] };
    expect(quoted.type).toBe("color");
    expect(quoted.color).toBe(color);
    expect(quoted.content).toEqual(['"hello"']);
    expect(result[2]).toBe(" quietly.");
  });

  it("highlights mid-quote line when startInQuote is true", () => {
    // Line entirely inside a quote
    const nodes = parseFormatting("the darkness that");
    const result = highlightQuotesWithState(nodes, color, true);
    // Entire text should be wrapped in a color node (mid-quote)
    expect(result).toHaveLength(1);
    const tag = result[0] as { type: "color"; color: string; content: FormattingNode[] };
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
    const openQuote = result[1] as { type: "color"; color: string; content: FormattingNode[] };
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

describe("nodeVisibleLength", () => {
  it("counts plain text characters", () => {
    expect(nodeVisibleLength(["hello world"])).toBe(11);
  });

  it("skips bold tags", () => {
    expect(nodeVisibleLength(parseFormatting("<b>bold</b>"))).toBe(4);
  });

  it("skips italic tags", () => {
    expect(nodeVisibleLength(parseFormatting("<i>italic</i>"))).toBe(6);
  });

  it("skips color tags", () => {
    expect(nodeVisibleLength(parseFormatting("<color=#ff0000>red text</color>"))).toBe(8);
  });

  it("skips nested tags", () => {
    expect(nodeVisibleLength(parseFormatting("<b><i>nested</i></b>"))).toBe(6);
  });

  it("returns 0 for empty array", () => {
    expect(nodeVisibleLength([])).toBe(0);
  });

  it("handles mixed tags and text", () => {
    expect(nodeVisibleLength(parseFormatting("Hello <b>world</b>!"))).toBe(12);
  });
});

describe("wrapNodes", () => {
  it("returns short line unchanged", () => {
    const nodes = parseFormatting("hello");
    const result = wrapNodes(nodes, 80);
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("hello");
  });

  it("wraps at word boundary", () => {
    const nodes = parseFormatting("hello world");
    const result = wrapNodes(nodes, 6);
    expect(result).toHaveLength(2);
    expect(toPlainText(result[0])).toBe("hello");
    expect(toPlainText(result[1])).toBe("world");
  });

  it("wraps long text into multiple lines", () => {
    const nodes = parseFormatting("aaa bbb ccc ddd");
    const result = wrapNodes(nodes, 8);
    expect(result).toHaveLength(2);
    expect(toPlainText(result[0])).toBe("aaa bbb");
    expect(toPlainText(result[1])).toBe("ccc ddd");
  });

  it("handles hard break (single word exceeds width)", () => {
    const nodes = parseFormatting("abcdefghij");
    const result = wrapNodes(nodes, 5);
    // Word exceeds width but can't split — goes through on its own line
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("abcdefghij");
  });

  it("skips tags when counting width", () => {
    // "<b>hello</b> world" = 11 visible chars; with width=12 it fits
    const nodes = parseFormatting("<b>hello</b> world");
    const result = wrapNodes(nodes, 12);
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("hello world");
  });

  it("wraps tag-containing text correctly", () => {
    // "<b>hello</b> world foo" = 15 visible; width=10 should wrap
    const nodes = parseFormatting("<b>hello</b> world foo");
    const result = wrapNodes(nodes, 10);
    expect(result).toHaveLength(2);
    expect(toPlainText(result[0])).toBe("hello");
    expect(toPlainText(result[1])).toBe("world foo");
  });

  it("preserves tag structure across wrapping", () => {
    // Bold tag wraps — each line should have valid bold nodes
    const nodes = parseFormatting("<b>hello world</b>");
    const result = wrapNodes(nodes, 6);
    expect(result).toHaveLength(2);
    // First line should contain a bold node
    const first = result[0].find((n) => typeof n !== "string" && n.type === "bold");
    expect(first).toBeDefined();
    // Second line should also contain a bold node
    const second = result[1].find((n) => typeof n !== "string" && n.type === "bold");
    expect(second).toBeDefined();
  });

  it("does not wrap alignment lines", () => {
    const nodes = parseFormatting("<center>This is a very long centered title that exceeds width</center>");
    const result = wrapNodes(nodes, 20);
    expect(result).toHaveLength(1);
  });

  it("returns nodes unchanged when width is 0", () => {
    const nodes = parseFormatting("hello world");
    const result = wrapNodes(nodes, 0);
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("hello world");
  });

  it("handles empty nodes", () => {
    const result = wrapNodes([], 80);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([]);
  });

  it("preserves space before tag node", () => {
    // "text <i>d</i> more" — space between "text" and italic must not be eaten
    const nodes = parseFormatting("text <i>d</i> more");
    const result = wrapNodes(nodes, 80);
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("text d more");
  });

  it("preserves space after tag node with trailing space in content", () => {
    // {italic: ["hello "]} followed by "world" — space inside tag before sibling
    const nodes = parseFormatting("<i>hello </i>world");
    const result = wrapNodes(nodes, 80);
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("hello world");
  });

  it("does not insert space where none exists at tag boundary", () => {
    // "c<i>d</i> e" — no space between c and italic d
    const nodes = parseFormatting("c<i>d</i> e");
    const result = wrapNodes(nodes, 80);
    expect(result).toHaveLength(1);
    expect(toPlainText(result[0])).toBe("cd e");
  });
});

describe("processNarrativeLines", () => {
  const dm = (text: string): NarrativeLine => ({ kind: "dm", text });

  it("b/i/u persist across source boundaries", () => {
    const result = processNarrativeLines([
      dm("<i>italic start"),
      dm("still italic</i>"),
    ], 80);
    // Second line should have italic content
    const plain1 = toPlainText(result[1].nodes);
    expect(plain1).toBe("still italic");
    // Check that it's wrapped in italic
    const hasItalic = result[1].nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    expect(hasItalic).toBe(true);
  });

  it("color resets at source line boundary", () => {
    const result = processNarrativeLines([
      dm("<color=#ff0000>red text"),
      dm("next line"),
    ], 80);
    // Second line should NOT have color
    const plain1 = toPlainText(result[1].nodes);
    expect(plain1).toBe("next line");
    // Should be plain text, no color tag
    expect(result[1].nodes).toEqual(["next line"]);
  });

  it("b persists but color resets at source boundary", () => {
    const result = processNarrativeLines([
      dm("<b><color=#ff0000>bold red"),
      dm("next line</b>"),
    ], 80);
    // Second line should be bold but not colored
    const plain1 = toPlainText(result[1].nodes);
    expect(plain1).toBe("next line");
    const hasBold = result[1].nodes.some(
      (n) => typeof n !== "string" && n.type === "bold",
    );
    expect(hasBold).toBe(true);
    // Should NOT have a color tag at the top level
    const hasColor = result[1].nodes.some(
      (n) => typeof n !== "string" && n.type === "color",
    );
    expect(hasColor).toBe(false);
  });

  it("handles lines with no tags", () => {
    const result = processNarrativeLines([dm("plain line"), dm("another line")], 80);
    expect(toPlainText(result[0].nodes)).toBe("plain line");
    expect(toPlainText(result[1].nodes)).toBe("another line");
  });

  it("handles empty lines array", () => {
    expect(processNarrativeLines([], 80)).toEqual([]);
  });

  it("handles width 0 (no wrapping, still heals)", () => {
    const result = processNarrativeLines([
      dm("<i>italic"),
      dm("continued</i>"),
    ], 0);
    // Both lines should have italic content
    const hasItalic0 = result[0].nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    const hasItalic1 = result[1].nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    expect(hasItalic0).toBe(true);
    expect(hasItalic1).toBe(true);
  });

  it("color does not leak across multiple source lines", () => {
    const result = processNarrativeLines([
      dm("<color=#ff0000>red</color>"),
      dm("normal"),
      dm("<color=#00ff00>green"),
      dm("should not be green"),
    ], 80);
    expect(toPlainText(result[1].nodes)).toBe("normal");
    expect(result[1].nodes).toEqual(["normal"]);
    expect(toPlainText(result[3].nodes)).toBe("should not be green");
    expect(result[3].nodes).toEqual(["should not be green"]);
  });

  it("pads alignment lines with blank lines", () => {
    const result = processNarrativeLines([
      dm("Before"),
      dm("<center>Title</center>"),
      dm("After"),
    ], 80);
    // Should be: Before, blank, center, blank, After
    expect(result).toHaveLength(5);
    expect(toPlainText(result[0].nodes)).toBe("Before");
    expect(toPlainText(result[1].nodes)).toBe(""); // blank
    expect(result[2].alignment).toBe("center");
    expect(toPlainText(result[3].nodes)).toBe(""); // blank
    expect(toPlainText(result[4].nodes)).toBe("After");
  });

  it("pads right alignment lines", () => {
    const result = processNarrativeLines([
      dm("Before"),
      dm("<right>— Author</right>"),
      dm("After"),
    ], 80);
    expect(result).toHaveLength(5);
    expect(result[2].alignment).toBe("right");
  });

  it("does not double-pad when blank line already present", () => {
    const result = processNarrativeLines([
      dm("Some text"),
      dm(""),
      dm("<center>Title</center>"),
    ], 80);
    // blank line already before center, should not add another
    expect(result).toHaveLength(3);
  });

  it("quote highlighting works within processNarrativeLines", () => {
    const quoteColor = "#ffffff";
    const result = processNarrativeLines([
      dm('He said "hello" quietly.'),
    ], 80, quoteColor);
    // Should have quote-highlighted nodes
    const hasQuoteColor = result[0].nodes.some(
      (n) => typeof n !== "string" && n.type === "color" && n.color === quoteColor,
    );
    expect(hasQuoteColor).toBe(true);
  });

  it("multiline quotes highlight correctly across lines", () => {
    const quoteColor = "#ffffff";
    const result = processNarrativeLines([
      dm('The wizard said "Beware'),
      dm("the darkness that"),
      dm('lurks within." Then silence.'),
    ], 80, quoteColor);
    // Middle line should be entirely highlighted (mid-quote)
    const midLineNodes = result[1].nodes;
    const hasColor = midLineNodes.some(
      (n) => typeof n !== "string" && n.type === "color" && n.color === quoteColor,
    );
    expect(hasColor).toBe(true);
  });

  it("unbalanced quote in paragraph 1 does NOT affect paragraph 2", () => {
    const quoteColor = "#ffffff";
    const result = processNarrativeLines([
      dm('He said "hello'),      // unbalanced open quote
      dm(""),                     // blank line = paragraph boundary
      dm("Normal text here."),    // should NOT be highlighted
    ], 80, quoteColor);
    // The blank line resets quote state — paragraph 2 should be plain
    const para2Nodes = result[2].nodes;
    const hasColor = para2Nodes.some(
      (n) => typeof n !== "string" && n.type === "color" && n.color === quoteColor,
    );
    expect(hasColor).toBe(false);
  });

  it("multi-line quotes within a paragraph still highlight correctly", () => {
    const quoteColor = "#ffffff";
    const result = processNarrativeLines([
      dm('"Hello'),
      dm('world"'),
    ], 80, quoteColor);
    // Both lines should have quote highlighting
    const line0HasColor = result[0].nodes.some(
      (n) => typeof n !== "string" && n.type === "color" && n.color === quoteColor,
    );
    const line1HasColor = result[1].nodes.some(
      (n) => typeof n !== "string" && n.type === "color" && n.color === quoteColor,
    );
    expect(line0HasColor).toBe(true);
    expect(line1HasColor).toBe(true);
  });

  it("non-dm lines pass through without affecting DM formatting state", () => {
    const result = processNarrativeLines([
      { kind: "system", text: "Welcome to the game." },
      dm("<b>bold</b> text"),
      { kind: "player", text: "> Alice: attack" },
    ], 80);
    // No automatic separators — turn boundaries are handled by the engine
    const kinds = result.map((l) => l.kind);
    expect(kinds.filter((k) => k === "system")).toHaveLength(1);
    expect(kinds.filter((k) => k === "dm")).toHaveLength(1);
    expect(kinds.filter((k) => k === "player")).toHaveLength(1);
    expect(result[0].kind).toBe("system");
    expect(result[result.length - 1].kind).toBe("player");
  });

  it("dev lines with JSON quotes do not corrupt quote state", () => {
    const quoteColor = "#ffffff";
    const result = processNarrativeLines([
      dm('He said "hello'),
      { kind: "dev", text: '[dev] tool:read → {"name":"value"}' },
      dm('world"'),
    ], 80, quoteColor);
    // The dev line should not affect DM quote state
    // Find the last dm line
    const dmLines = result.filter((l) => l.kind === "dm");
    const lastDM = dmLines[dmLines.length - 1];
    const hasColor = lastDM.nodes.some(
      (n) => typeof n !== "string" && n.type === "color" && n.color === quoteColor,
    );
    expect(hasColor).toBe(true);
  });

  it("dev lines with formatting tags do not corrupt heal state", () => {
    const result = processNarrativeLines([
      dm("<i>italic start"),
      { kind: "dev", text: "[dev] tool:read → <b>unclosed" },
      dm("still italic</i>"),
    ], 80);
    // First DM line should have italic
    const hasItalic0 = result[0].nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    expect(hasItalic0).toBe(true);
    // Dev line passes through as plain text (separators may also have kind "dev")
    const devContent = result.filter((l) => l.kind === "dev" && toPlainText(l.nodes) !== "");
    expect(devContent).toHaveLength(1);
    // Last DM line should still have italic from cross-line healing
    const dmLines = result.filter((l) => l.kind === "dm");
    const lastDM = dmLines[dmLines.length - 1];
    const hasItalic = lastDM.nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    expect(hasItalic).toBe(true);
  });

  it("does not insert automatic separators at kind transitions", () => {
    const result = processNarrativeLines([
      dm("DM narration."),
      { kind: "player", text: "> I attack." },
      dm("The blow lands."),
    ], 80);
    // No automatic separators — turn boundaries managed by engine callbacks
    expect(result).toHaveLength(3);
    expect(toPlainText(result[0].nodes)).toBe("DM narration.");
    expect(toPlainText(result[1].nodes)).toBe("> I attack.");
    expect(toPlainText(result[2].nodes)).toBe("The blow lands.");
  });

  it("dangling b/i/u does not bleed past paragraph boundary (blank DM line)", () => {
    const result = processNarrativeLines([
      dm("<i>italic start — never closed"),
      dm(""),                               // blank line = paragraph boundary
      dm("Normal text in new paragraph."),
    ], 80);
    // Third line should be plain text — NOT wrapped in italic
    const thirdDM = result.filter((l) => l.kind === "dm").find(
      (l) => toPlainText(l.nodes) === "Normal text in new paragraph.",
    );
    expect(thirdDM).toBeDefined();
    const hasItalic = thirdDM!.nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    expect(hasItalic).toBe(false);
  });

  it("dangling b does not bleed past paragraph boundary", () => {
    const result = processNarrativeLines([
      dm("<b>bold — never closed"),
      dm("still in first paragraph, still bold"),
      dm(""),                               // paragraph boundary
      dm("Fresh paragraph, not bold."),
    ], 80);
    const dmLines = result.filter((l) => l.kind === "dm");
    const lastDM = dmLines[dmLines.length - 1];
    expect(toPlainText(lastDM.nodes)).toBe("Fresh paragraph, not bold.");
    const hasBold = lastDM.nodes.some(
      (n) => typeof n !== "string" && n.type === "bold",
    );
    expect(hasBold).toBe(false);
  });

  it("b/i/u still persist within a paragraph (no blank line between)", () => {
    // Existing cross-line behaviour must be preserved
    const result = processNarrativeLines([
      dm("<i>italic start"),
      dm("still italic</i>"),
    ], 80);
    const hasItalic = result[1].nodes.some(
      (n) => typeof n !== "string" && n.type === "italic",
    );
    expect(hasItalic).toBe(true);
  });

  it("no separator between consecutive lines of same kind", () => {
    const result = processNarrativeLines([
      dm("First paragraph."),
      dm("Second paragraph."),
    ], 80);
    expect(result).toHaveLength(2);
    expect(toPlainText(result[0].nodes)).toBe("First paragraph.");
    expect(toPlainText(result[1].nodes)).toBe("Second paragraph.");
  });

  it("wrapping preserves tag structure (no broken tags)", () => {
    const result = processNarrativeLines([
      dm("<b>hello world</b>"),
    ], 6);
    // Should wrap into 2 lines, each with valid bold structure
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const line of result) {
      const hasBold = line.nodes.some(
        (n) => typeof n !== "string" && n.type === "bold",
      );
      expect(hasBold).toBe(true);
    }
  });
});
