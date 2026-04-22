import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { renderNodes } from "./render-nodes.js";
import { parseFormatting } from "./formatting.js";

function renderToString(input: string): string {
  const { lastFrame } = render(<Text>{renderNodes(parseFormatting(input))}</Text>);
  return lastFrame() ?? "";
}

describe("renderNodes sub/sup", () => {
  it("substitutes digits in superscript", () => {
    expect(renderToString("E=mc<sup>2</sup>")).toBe("E=mc²");
  });

  it("substitutes digits in subscript", () => {
    expect(renderToString("H<sub>2</sub>O")).toBe("H₂O");
  });

  it("substitutes lowercase letters in superscript", () => {
    expect(renderToString("x<sup>n</sup>")).toBe("xⁿ");
  });

  it("substitutes ordinal suffixes in superscript", () => {
    expect(renderToString("1<sup>st</sup>")).toBe("1ˢᵗ");
  });

  it("passes unmapped characters through unchanged", () => {
    // 'q' has no Unicode superscript equivalent, 'b' is in the map
    expect(renderToString("<sup>qb</sup>")).toBe("qᵇ");
  });

  it("handles subscript nested inside superscript without double-transform", () => {
    // Regression: outer transform must NOT descend into inner sub/sup.
    // If it did, the inner "2" would be substituted by the outer SUPERSCRIPT_MAP
    // to "²", then the inner <sub> renderer would see "²" (not in subscript
    // map) and pass it through — producing "a²²" instead of "a²₂".
    expect(renderToString("a<sup>2<sub>2</sub></sup>")).toBe("a²₂");
  });

  it("handles superscript nested inside subscript without double-transform", () => {
    expect(renderToString("a<sub>1<sup>2</sup></sub>")).toBe("a₁²");
  });

  it("preserves nested formatting tags inside sub/sup", () => {
    // <b> inside <sup> should still render, with digits substituted.
    // We can't easily verify bold styling from the frame string, but we
    // can verify the text substitution flows through the bold wrapper.
    expect(renderToString("x<sup><b>2</b></sup>")).toBe("x²");
  });
});
