import React from "react";
import { Text } from "ink";
import type { FormattingNode, FormattingTag } from "@machine-violet/shared/types/tui.js";

/** Render a FormattingNode tree into React elements for Ink. */
export function renderNodes(nodes: FormattingNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === "string") {
      return <React.Fragment key={i}>{node}</React.Fragment>;
    }
    return <React.Fragment key={i}>{renderTag(node)}</React.Fragment>;
  });
}

function renderTag(tag: FormattingTag): React.ReactNode {
  if (tag.type === "subscript") {
    return <Text>{renderNodes(transformText(tag.content, SUBSCRIPT_MAP))}</Text>;
  }
  if (tag.type === "superscript") {
    return <Text>{renderNodes(transformText(tag.content, SUPERSCRIPT_MAP))}</Text>;
  }

  const children = renderNodes(tag.content);

  switch (tag.type) {
    case "bold":
      return <Text bold>{children}</Text>;
    case "italic":
      return <Text italic>{children}</Text>;
    case "underline":
      return <Text underline>{children}</Text>;
    case "color":
      return <Text color={tag.color}>{children}</Text>;
    case "center":
    case "right":
      // Alignment is handled at the NarrativeLine level when this is a
      // top-level tag. Nested inside other formatting, render children inline.
      return <Text>{children}</Text>;
  }
}

// Unicode sub/superscript maps. Chars without an equivalent pass through.
const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  "*": "﹡", // U+FE61 SMALL ASTERISK — no true superscript asterisk exists
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ",
  h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ",
  o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ",
  w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ",
  J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ",
  R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
};

const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  "*": "⁎", // U+204E LOW ASTERISK
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ",
  m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ",
  u: "ᵤ", v: "ᵥ", x: "ₓ",
};

function substituteChars(text: string, map: Record<string, string>): string {
  let out = "";
  for (const ch of text) out += map[ch] ?? ch;
  return out;
}

function transformText(
  nodes: FormattingNode[],
  map: Record<string, string>,
): FormattingNode[] {
  return nodes.map((node) => {
    if (typeof node === "string") return substituteChars(node, map);
    // Stop at nested sub/sup — the inner renderer applies its own map.
    // Pre-substituting would double-transform chars present in both maps
    // (e.g. digits), breaking H<sub>1<sup>2</sup></sub> → "₁²".
    if (node.type === "subscript" || node.type === "superscript") return node;
    return { ...node, content: transformText(node.content, map) } as FormattingTag;
  });
}
