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
import { QUOTE_RULE } from "../layout.js";
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
  quote: "<quote>The inscription read: <i>Here lies the last honest broker.</i> Beneath it, someone had scratched <color=#cc0000>LIAR</color> deep into the stone.</quote>",
  quoteBr: "<quote><color=#cc0000>SYSTEM ALERT</color><br>Reactor breach in sector seven<br>Evacuate the platform immediately</quote>",
  ulist: "Pack list:\n- A coil of rope\n- <b>Three</b> oil torches\n- A spare lantern that will absolutely not fit inside a narrow forty-column terminal pane at all",
  olist: "Plan:\n1. Bread primary.\n2. Crackers forbidden, by order of the tribunal that convenes at dawn beneath the great oven.\n3. Muffins await.",
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
  let el: React.ReactElement;
  if (line.kind === "list") {
    const indent = line.listIndent ?? 0;
    el = line.listMarker !== undefined ? (
      <Box width={width}><Text wrap="truncate"><Text>{line.listMarker} </Text>{renderNodes(line.nodes)}</Text></Box>
    ) : (
      <Box width={width}><Text wrap="truncate">{" ".repeat(indent)}{renderNodes(line.nodes)}</Text></Box>
    );
  } else {
    const sole = line.nodes.length === 1 && typeof line.nodes[0] !== "string" ? line.nodes[0] : undefined;
    if (sole && sole.type === "quote") {
      el = <Box width={width}><Text wrap="truncate"><Text dimColor>{QUOTE_RULE} </Text>{renderNodes(sole.content)}</Text></Box>;
    } else if (line.alignment) {
      el = (
        <Box width={width} justifyContent={line.alignment === "center" ? "center" : "flex-end"}>
          <Text wrap="truncate">{renderNodes(unwrapAligned(line))}</Text>
        </Box>
      );
    } else {
      el = <Box width={width}><Text wrap="truncate">{renderNodes(line.nodes)}</Text></Box>;
    }
  }
  return render(el).lastFrame() ?? "";
}

describe("formatting harness — render-level ground truth", () => {
  for (const [name, raw] of Object.entries(CASES)) {
    for (const width of [40, 80]) {
      it(`${name} @ w=${width}: renders without truncation or leaks`, () => {
        const lines: NarrativeLine[] = appendDelta([], raw, "dm");
        const out = processNarrativeLines(lines, width, "#ffffff");
        for (const line of out) {
          if (line.kind !== "dm" && line.kind !== "list") continue;
          const atWidth = renderLine(line, width).replace(ANSI, "");
          // No tag-shaped markup leaks into the rendered frame.
          expect(atWidth).not.toMatch(/<\/?(?:b|i|u|sub|sup|center|right|color|code|br|quote)\b/i);
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
