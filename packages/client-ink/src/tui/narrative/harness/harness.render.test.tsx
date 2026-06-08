/**
 * Render-level ground truth for the formatting harness.
 *
 * The AST-level invariants (harness.test.ts) measure width with the `string-width`
 * oracle. This file closes the loop by rendering processed lines through the REAL
 * Ink renderer (`renderNodes`) inside a width-constrained Box — exactly as
 * `NarrativeLineComponent` does — and asserting that nothing is truncated (Ink's
 * own layout agrees that every row fits) and no markup leaks into the frame.
 * A curated handful of cases keeps this fast; the AST harness carries the bulk.
 */
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { renderNodes } from "../../render-nodes.js";
import { processNarrativeLines } from "../../formatting.js";
import { appendDelta } from "../../narrative-helpers.js";
import type { FormattingNode, NarrativeLine, ProcessedLine } from "@machine-violet/shared/types/tui.js";

const CASES: Record<string, string> = {
  sign: "<center><color=#cc0000>OCCUPANCY VERIFIED: 2</color><br><color=#20b2aa>TRANSIT AUTHORIZED</color></center>",
  longCenter: "<center>This is a very long centered banner that will not fit a narrow terminal</center>",
  wide: "She wrote 你好世界 on the blade and smiled at the café glow.",
  longToken: "Path: <b>supercalifragilisticexpialidociousantidisestablishmentarianism</b> end.",
  subsup: "H<sub>2</sub>O and E=mc<sup>2</sup> and the 1<sup>st</sup>.",
  code: "Type <code>npm test</code> then <code>git push</code>.",
  nested: "<b><color=#20b2aa>bold <i>and italic</i></color></b> tail text here for wrapping.",
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const alnum = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "");

function unwrapAligned(line: ProcessedLine): FormattingNode[] {
  const first = line.nodes[0];
  if (line.nodes.length === 1 && typeof first !== "string" && "content" in first) return first.content;
  return line.nodes;
}

/** Render one processed line the way NarrativeLineComponent does, return frame. */
function renderLine(line: ProcessedLine, width: number): string {
  const el = line.alignment ? (
    <Box width={width} justifyContent={line.alignment === "center" ? "center" : "flex-end"}>
      <Text wrap="truncate">{renderNodes(unwrapAligned(line))}</Text>
    </Box>
  ) : (
    <Box width={width}><Text wrap="truncate">{renderNodes(line.nodes)}</Text></Box>
  );
  return render(el).lastFrame() ?? "";
}

describe("formatting harness — render-level ground truth", () => {
  for (const [name, raw] of Object.entries(CASES)) {
    for (const width of [40, 80]) {
      it(`${name} @ w=${width}: renders without truncation or leaks`, () => {
        const lines: NarrativeLine[] = appendDelta([], raw, "dm");
        const out = processNarrativeLines(lines, width, "#ffffff");
        for (const line of out) {
          if (line.kind !== "dm") continue;
          const atWidth = renderLine(line, width).replace(ANSI, "");
          // No tag-shaped markup leaks into the rendered frame.
          expect(atWidth).not.toMatch(/<\/?(?:b|i|u|sub|sup|center|right|color|code|br)\b/i);
          // Nothing truncated: rendering at the target width yields the same
          // visible content as rendering unconstrained (substitution-agnostic,
          // so sub/sup glyph mapping doesn't trip the comparison).
          const atFull = renderLine(line, 9999).replace(ANSI, "");
          expect(alnum(atWidth)).toBe(alnum(atFull));
        }
      });
    }
  }
});
