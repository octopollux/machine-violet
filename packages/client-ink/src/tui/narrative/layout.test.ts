import { layoutRuns, splitOnLinebreaks } from "./layout.js";
import { parseFormatting, processNarrativeLines, toPlainText } from "../formatting.js";
import { stringWidth } from "../frames/string-width.js";
import type { FormattingTag, NarrativeLine } from "@machine-violet/shared/types/tui.js";

const dm = (text: string): NarrativeLine => ({ kind: "dm", text });
const rowWidth = (nodes: import("@machine-violet/shared/types/tui.js").FormattingNode[]): number =>
  stringWidth(toPlainText(nodes));

describe("splitOnLinebreaks", () => {
  it("splits a flat run at <br> leaves", () => {
    const segs = splitOnLinebreaks(parseFormatting("a<br>b<br>c"));
    expect(segs.map(toPlainText)).toEqual(["a", "b", "c"]);
  });

  it("preserves tag nesting across a break", () => {
    const segs = splitOnLinebreaks(parseFormatting("<b>one<br>two</b>"));
    expect(segs).toHaveLength(2);
    expect((segs[0][0] as FormattingTag).type).toBe("bold");
    expect((segs[1][0] as FormattingTag).type).toBe("bold");
    expect(segs.map(toPlainText)).toEqual(["one", "two"]);
  });

  it("yields an empty segment for consecutive breaks", () => {
    const segs = splitOnLinebreaks(parseFormatting("a<br><br>b"));
    expect(segs.map(toPlainText)).toEqual(["a", "", "b"]);
  });
});

describe("layoutRuns", () => {
  it("returns a short run as one row", () => {
    expect(layoutRuns(parseFormatting("hello there"), 80).map(toPlainText)).toEqual(["hello there"]);
  });

  it("word-wraps by width", () => {
    const rows = layoutRuns(parseFormatting("aaa bbb ccc ddd"), 8).map(toPlainText);
    expect(rows).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("hard-breaks a single token wider than the row", () => {
    const rows = layoutRuns(parseFormatting("abcdefghij"), 5).map(toPlainText);
    expect(rows).toEqual(["abcde", "fghij"]);
  });

  it("hard-breaks a styled long token, preserving the tag on each piece", () => {
    const rows = layoutRuns(parseFormatting("<b>abcdefghij</b>"), 5);
    expect(rows.map(toPlainText)).toEqual(["abcde", "fghij"]);
    for (const row of rows) {
      expect(row.some((n) => typeof n !== "string" && n.type === "bold")).toBe(true);
    }
  });

  it("measures by DISPLAY width — CJK counts double", () => {
    // 4 CJK chars = 8 display columns; width 5 → two rows of 2 chars (4 cols).
    const rows = layoutRuns(parseFormatting("你好世界"), 5);
    for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(5);
    expect(rows.map(toPlainText).join("")).toBe("你好世界");
  });

  it("splits a run on <br> then wraps each segment", () => {
    const rows = layoutRuns(parseFormatting("alpha beta<br>gamma delta epsilon"), 11).map(toPlainText);
    expect(rows[0]).toBe("alpha beta");
    expect(rows.join(" ")).toContain("gamma delta");
  });

  it("does not wrap at width 0", () => {
    expect(layoutRuns(parseFormatting("a b c d e"), 0).map(toPlainText)).toEqual(["a b c d e"]);
  });
});

describe("processNarrativeLines — width safety (INV-WIDTH)", () => {
  it("wraps a long centered banner instead of overflowing", () => {
    const result = processNarrativeLines(
      [dm("<center>This is a very long centered banner line that exceeds the width</center>")],
      20,
    );
    const centered = result.filter((l) => l.alignment === "center");
    expect(centered.length).toBeGreaterThan(1);
    for (const line of centered) {
      expect(rowWidth(line.nodes)).toBeLessThanOrEqual(20);
      expect(line.padWidth).toBe(20);
    }
  });

  it("renders a multi-line <br> sign as independent centered rows", () => {
    const result = processNarrativeLines(
      [dm("<center><color=#cc0000>OCCUPANCY VERIFIED: 2</color><br><color=#20b2aa>TRANSIT AUTHORIZED</color></center>")],
      80,
    );
    const centered = result.filter((l) => l.alignment === "center");
    const texts = centered.map((l) => toPlainText(l.nodes));
    expect(texts).toContain("OCCUPANCY VERIFIED: 2");
    expect(texts).toContain("TRANSIT AUTHORIZED");
    // No literal <br> leaked anywhere.
    for (const l of result) expect(toPlainText(l.nodes)).not.toContain("<br>");
  });

  it("keeps every wrapped prose row within the terminal width", () => {
    const long = "supercalifragilisticexpialidocious " + "word ".repeat(30).trim();
    const result = processNarrativeLines([dm(long)], 24);
    for (const line of result) {
      if (line.kind === "dm") expect(rowWidth(line.nodes)).toBeLessThanOrEqual(24);
    }
  });
});
