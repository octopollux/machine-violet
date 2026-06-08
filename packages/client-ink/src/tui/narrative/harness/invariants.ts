/**
 * The formatting contract, as machine-checkable invariants.
 *
 * `checkInvariants` runs the REAL pipeline (`processNarrativeLines`) over an input
 * at a given width and returns every invariant violation it finds. The harness
 * drives this over three input sources (synthetic fixtures, the committed real
 * corpus, and the seeded generator) at many widths; zero violations everywhere is
 * the acceptance gate.
 *
 * Invariants (for input D at width W):
 *  - NO-LEAK     no tag-shaped markup survives into rendered text
 *  - WIDTH       every physical row's display width ≤ W
 *  - WELLFORMED  output AST is structurally valid (no contentless non-leaf, etc.)
 *  - ALIGN       aligned rows carry padWidth and fit within it
 *  - CONTENT     the alphanumeric content of D is preserved (nothing dropped)
 *  - DETERMINISM pure + stable, and split-at-blank == whole (cache transparency)
 */
import type { FormattingNode, NarrativeLine, ProcessedLine } from "@machine-violet/shared/types/tui.js";
import { processNarrativeLines, toPlainText } from "../../formatting.js";
import { normalizeDialect } from "../normalize.js";
import { stringWidth } from "../../frames/string-width.js";

// Mirrors EXACTLY what `parseFormatting` strips: any well-formed tag — canonical
// (<b>, <color=#hex>, <br>, …) or unknown (<span style="…">) — including unclosed
// ones (which healing closes). A bare '<' that isn't tag-shaped stays. Used to
// compute the expected visible content for the CONTENT invariant.
const STRIP_TAGS_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*\s*(?:\/?>|[^<>]*=[^<>]*>)/g;

export interface Violation {
  inv: string;
  detail: string;
}

// Tag names that must NEVER appear literally in rendered output. A real leak is a
// known/HTML-ish tag name in angle brackets; arbitrary prose like `<j and j>` is
// legitimately literal and is not flagged.
const LEAK_RE = /<\/?(?:b|i|u|sub|sup|center|right|color|code|br|strong|em|h[1-6]|span|div|table|thead|tbody|tr|td|th|ul|ol|li|p|blockquote|hr|a|img|font|small|mark|del|s|strike|pre|details|summary)\b[^<>]*>/i;

const ALPHANUM = /[^\p{L}\p{N}]/gu;

function alnum(s: string): string {
  return s.replace(ALPHANUM, "");
}

/** Recurse an output node tree, collecting structural violations. */
function checkWellformed(nodes: FormattingNode[], out: Violation[]): void {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    switch (n.type) {
      case "linebreak":
        if ("content" in n) out.push({ inv: "WELLFORMED", detail: "linebreak has content" });
        break;
      case "color":
        if (typeof n.color !== "string" || !n.color) out.push({ inv: "WELLFORMED", detail: "color missing color" });
        checkWellformed(n.content, out);
        break;
      case "wikilink":
        if (typeof n.target !== "string") out.push({ inv: "WELLFORMED", detail: "wikilink missing target" });
        checkWellformed(n.content, out);
        break;
      default:
        if (!Array.isArray((n as { content?: unknown }).content)) {
          out.push({ inv: "WELLFORMED", detail: `${n.type} missing content` });
        } else {
          checkWellformed((n as { content: FormattingNode[] }).content, out);
        }
    }
  }
}

/** Plain text of all DM/player output rows, joined — what the reader sees. */
function outputText(lines: ProcessedLine[]): string {
  return lines
    .filter((l) => l.kind === "dm" || l.kind === "player" || l.kind === "list")
    .map((l) => toPlainText(l.nodes))
    .join(" ");
}

/** Expected visible content: normalize each DM line then remove every well-formed
 *  tag token (exactly as the parser does, including unclosed/healed ones). */
function expectedText(input: NarrativeLine[]): string {
  return input
    .filter((l): l is Extract<NarrativeLine, { kind: "dm" | "player" }> => l.kind === "dm" || l.kind === "player")
    .map((l) => (l.kind === "dm" ? normalizeDialect(l.text).replace(STRIP_TAGS_RE, "") : l.text))
    .join(" ");
}

/**
 * Run the pipeline on `input` at `width` and return all invariant violations.
 * `width <= 0` disables wrapping, so the WIDTH/ALIGN checks are skipped there.
 */
export function checkInvariants(
  input: NarrativeLine[],
  width: number,
  quoteColor = "#ffffff",
): Violation[] {
  const v: Violation[] = [];
  const out = processNarrativeLines(input, width, quoteColor);

  for (const line of out) {
    if (line.kind === "separator" || line.kind === "image" || line.kind === "spacer") continue;
    const plain = toPlainText(line.nodes);

    // NO-LEAK
    if (LEAK_RE.test(plain)) {
      v.push({ inv: "NO-LEAK", detail: `leaked markup in row: ${JSON.stringify(plain.slice(0, 80))}` });
    }

    // WIDTH
    if (width > 0) {
      const w = stringWidth(plain);
      if (w > width) {
        v.push({ inv: "WIDTH", detail: `row width ${w} > ${width}: ${JSON.stringify(plain.slice(0, 80))}` });
      }
    }

    // ALIGN
    if (line.alignment) {
      if (line.padWidth === undefined) {
        v.push({ inv: "ALIGN", detail: "aligned row missing padWidth" });
      } else if (stringWidth(plain) > line.padWidth) {
        v.push({ inv: "ALIGN", detail: `aligned content ${stringWidth(plain)} > padWidth ${line.padWidth}` });
      }
    }
  }

  // WELLFORMED
  for (const line of out) checkWellformed(line.nodes, v);

  // CONTENT (alphanumeric preservation)
  const got = alnum(outputText(out));
  const want = alnum(expectedText(input));
  if (got !== want) {
    v.push({ inv: "CONTENT", detail: `content drift: want ${want.length} alnum chars, got ${got.length}` });
  }

  // DETERMINISM (idempotent/pure)
  const out2 = processNarrativeLines(input, width, quoteColor);
  if (JSON.stringify(out) !== JSON.stringify(out2)) {
    v.push({ inv: "DETERMINISM", detail: "non-deterministic output across two runs" });
  }

  // DETERMINISM — cache transparency: splitting at any blank-DM boundary and
  // processing prefix+tail separately must equal processing the whole (this is
  // exactly what NarrativeArea's incremental `useProcessedLines` relies on).
  for (let i = 1; i < input.length; i++) {
    const l = input[i];
    if (l.kind === "dm" && l.text.trim() === "") {
      const head = processNarrativeLines(input.slice(0, i + 1), width, quoteColor);
      const tail = processNarrativeLines(input.slice(i + 1), width, quoteColor);
      if (JSON.stringify([...head, ...tail]) !== JSON.stringify(out)) {
        v.push({ inv: "DETERMINISM", detail: `split at blank #${i} != whole` });
      }
      break; // one representative split is enough per input
    }
  }

  return v;
}
