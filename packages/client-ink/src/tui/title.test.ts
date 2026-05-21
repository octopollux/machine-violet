import { describe, it, expect } from "vitest";
import { splitTitle, topFrameTitleBudget } from "./title.js";
import { resolveTheme } from "./themes/resolver.js";
import { resetThemeCache } from "./themes/loader.js";
import { BUILTIN_DEFINITIONS } from "./themes/builtin-definitions.js";

describe("splitTitle", () => {
  it("returns the original text when it fits", () => {
    expect(splitTitle("Warranty Void", 80)).toEqual(["Warranty Void"]);
  });

  it("packs segments greedily up to maxWidth", () => {
    const text = "Campaign | Resource A 1/10 | Resource B 5/5 | Resource C 0/3";
    // Fits comfortably on one line.
    expect(splitTitle(text, 80)).toEqual([text]);
  });

  it("wraps onto a new line when adding a segment would overflow", () => {
    const text = "Warranty Void | Processing Cycles 1/10 | Coherence 4/10 | Connections 3/5 | Memory Integrity 6/10";
    const lines = splitTitle(text, 70);
    // Each line must stay within budget.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(70);
    }
    // Joining the lines back with the same separator reconstructs the input.
    expect(lines.join(" | ")).toBe(text);
  });

  it("emits a single oversize line when one segment exceeds maxWidth", () => {
    const text = "Campaign | This Single Resource Has An Inordinately Long Name 1/10";
    const lines = splitTitle(text, 30);
    // The oversized segment lands on its own line; truncation isn't this
    // helper's job.
    expect(lines).toContain("This Single Resource Has An Inordinately Long Name 1/10");
  });

  it("returns the input unchanged when maxWidth <= 0", () => {
    // Degenerate input — degenerate output. Better than infinite-looping
    // or producing empty lines.
    expect(splitTitle("Campaign | Foo", 0)).toEqual(["Campaign | Foo"]);
  });
});

describe("topFrameTitleBudget", () => {
  it("subtracts corners + separators + 2 padding spaces from total width", () => {
    resetThemeCache();
    const gothic = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
    // Gothic row 0: corner_tl="╔═"(2) + corner_tr="═╗"(2) + sep_lt="═╡"(2) + sep_rt="╞═"(2) = 8.
    // 80 - 8 - 2 = 70.
    expect(topFrameTitleBudget(gothic.asset, 80)).toBe(70);
  });

  it("clamps to 0 when the row can't even hold an empty title", () => {
    resetThemeCache();
    const gothic = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
    expect(topFrameTitleBudget(gothic.asset, 5)).toBe(0);
  });
});
