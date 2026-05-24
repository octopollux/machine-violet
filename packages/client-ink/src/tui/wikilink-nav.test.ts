import { describe, it, expect } from "vitest";
import { collectWikilinks, markWikilinks } from "./wikilink-nav.js";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";

function wikilink(slug: string, name: string): FormattingNode {
  return {
    type: "wikilink",
    target: slug,
    content: [{ type: "color", color: "#abcdef", content: [name] }],
  };
}

describe("collectWikilinks", () => {
  it("returns refs in document order across rows", () => {
    const lines: FormattingNode[][] = [
      ["See ", wikilink("mira", "Mira"), " for details."],
      ["Also ", wikilink("voss", "Captain Voss"), " and ", wikilink("the-undercroft", "The Undercroft"), "."],
    ];
    const refs = collectWikilinks(lines, new Set());
    expect(refs.map((r) => r.slug)).toEqual(["mira", "voss", "the-undercroft"]);
    expect(refs.map((r) => r.name)).toEqual(["Mira", "Captain Voss", "The Undercroft"]);
    expect(refs.map((r) => r.rowIndex)).toEqual([0, 1, 1]);
    expect(refs.every((r) => r.broken === false)).toBe(true);
  });

  it("flags missing slugs as broken", () => {
    const lines: FormattingNode[][] = [
      [wikilink("alive", "Alive"), " ", wikilink("dead", "Dead")],
    ];
    const refs = collectWikilinks(lines, new Set(["dead"]));
    expect(refs[0].broken).toBe(false);
    expect(refs[1].broken).toBe(true);
  });

  it("descends into nested tags (e.g. bold around a wikilink)", () => {
    const lines: FormattingNode[][] = [
      [{ type: "bold", content: ["See ", wikilink("mira", "Mira")] }],
    ];
    const refs = collectWikilinks(lines, new Set());
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe("mira");
  });

  it("returns an empty array when no wikilinks present", () => {
    const lines: FormattingNode[][] = [["plain text"], [{ type: "bold", content: ["bold"] }]];
    expect(collectWikilinks(lines, new Set())).toEqual([]);
  });
});

describe("markWikilinks", () => {
  it("stamps `broken` on links whose slug is missing", () => {
    const lines: FormattingNode[][] = [[wikilink("alive", "Alive"), " ", wikilink("dead", "Dead")]];
    const marked = markWikilinks(lines, new Set(["dead"]), -1);
    const tags = marked[0].filter((n) => typeof n !== "string");
    expect((tags[0] as { broken?: boolean }).broken).toBeUndefined();
    expect((tags[1] as { broken?: boolean }).broken).toBe(true);
  });

  it("stamps `selected` only on the Nth wikilink in document order", () => {
    const lines: FormattingNode[][] = [
      [wikilink("a", "A"), " ", wikilink("b", "B")],
      [wikilink("c", "C")],
    ];
    const marked = markWikilinks(lines, new Set(), 1);
    const collect = (row: number) => marked[row].filter((n) => typeof n !== "string");
    const row0 = collect(0);
    expect((row0[0] as { selected?: boolean }).selected).toBeUndefined();
    expect((row0[1] as { selected?: boolean }).selected).toBe(true);
    const row1 = collect(1);
    expect((row1[0] as { selected?: boolean }).selected).toBeUndefined();
  });

  it("does not mutate the input tree", () => {
    const original: FormattingNode[][] = [[wikilink("mira", "Mira")]];
    const snapshot = JSON.stringify(original);
    markWikilinks(original, new Set(["mira"]), 0);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("leaves non-wikilink tags untouched", () => {
    const lines: FormattingNode[][] = [
      [{ type: "bold", content: ["hi"] }, " ", wikilink("mira", "Mira")],
    ];
    const marked = markWikilinks(lines, new Set(), 0);
    const bold = marked[0][0];
    expect(typeof bold).not.toBe("string");
    expect((bold as { type: string }).type).toBe("bold");
  });

  it("with selectedIndex out of range marks none selected", () => {
    const lines: FormattingNode[][] = [[wikilink("a", "A")]];
    const marked = markWikilinks(lines, new Set(), 99);
    const tag = marked[0][0] as { selected?: boolean };
    expect(tag.selected).toBeUndefined();
  });
});
