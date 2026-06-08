import type { FormattingNode, FormattingTag, NarrativeLine, ProcessedLine } from "@machine-violet/shared/types/tui.js";
import { stringWidth } from "./frames/string-width.js";
import { normalizeDialect } from "./narrative/normalize.js";
import { layoutRuns } from "./narrative/layout.js";

/**
 * Parse DM text with inline formatting tags into a tree of FormattingNodes.
 *
 * Supported tags: <b>, <i>, <u>, <sub>, <sup>, <center>, <right>, <code>,
 * <color=#hex>, <br> (a contentless line-break leaf), and the render-only
 * <wikilink slug=foo>...</wikilink> (emitted by the colorizer, not LLMs).
 * Tags can nest: <b><i>bold italic</i></b>.
 *
 * Anything tag-SHAPED but outside this vocabulary — unknown tags (<strong>,
 * <table>), attribute-laden variants (<b class="x">), or an orphan close left
 * by healing across a paragraph boundary (#454) — is STRIPPED to its content;
 * it never renders as literal markup (the INV-NO-LEAK guarantee). A bare '<'
 * that isn't tag-shaped (math `3 < 5`, an emoticon `<3`) stays literal.
 * Dialect synonyms and markdown are mapped upstream in `narrative/normalize.ts`.
 */
export function parseFormatting(input: string): FormattingNode[] {
  const result: FormattingNode[] = [];
  let i = 0;

  while (i < input.length) {
    // Look for opening tag
    const tagStart = input.indexOf("<", i);

    if (tagStart === -1) {
      // No more tags — rest is plain text
      pushText(result, input.slice(i));
      break;
    }

    // Add text before the tag
    if (tagStart > i) {
      pushText(result, input.slice(i, tagStart));
    }

    // Try to parse an opening tag
    const parsed = parseOpenTag(input, tagStart);
    if (!parsed) {
      // Tag-shaped but outside our vocabulary (unknown tag like <strong>, an
      // attribute-laden <b class="x">, or an orphan </i> left by healing across
      // a paragraph boundary, #454): strip the delimiter and keep any inner
      // content. Unknown markup never renders literally (INV-NO-LEAK).
      const generic = input.slice(tagStart).match(GENERIC_TAG_RE);
      if (generic) {
        i = tagStart + generic[0].length;
        continue;
      }
      // A bare '<' that isn't tag-shaped (math `3 < 5`, emoticon `<3`) is literal.
      pushText(result, "<");
      i = tagStart + 1;
      continue;
    }

    // Void tags (<br>) are contentless leaves — emit and move on (no close tag).
    if (parsed.void) {
      result.push({ type: "linebreak" });
      i = parsed.end;
      continue;
    }

    // Find the matching closing tag
    const closeTag = `</${parsed.tagName}>`;
    const closeIdx = findClosingTag(input, parsed.end, parsed.tagName);

    if (closeIdx === -1) {
      // No closing tag — treat as plain text
      pushText(result, input.slice(tagStart, parsed.end));
      i = parsed.end;
      continue;
    }

    // Recursively parse content between open and close tags
    const innerContent = input.slice(parsed.end, closeIdx);
    const children = parseFormatting(innerContent);

    const node = buildNode(parsed.type, parsed.color, parsed.target, children);
    if (node) {
      result.push(node);
    } else {
      // Unknown tag type — strip the tags, keep content
      result.push(...children);
    }

    i = closeIdx + closeTag.length;
  }

  return result;
}

/**
 * Convert a formatting tree back to plain text (strip all tags).
 */
export function toPlainText(nodes: FormattingNode[]): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      // A linebreak is structural (handled at layout) and carries no text.
      if (node.type === "linebreak") return "";
      return toPlainText(node.content);
    })
    .join("");
}

/** Parse and strip formatting tags from a string, returning plain text. */
export function stripFormatting(input: string): string {
  return toPlainText(parseFormatting(input));
}

/** Strip a leading Unicode bullet/symbol (e.g. ◆, ▸, ●, 🗡️) and whitespace after it. */
export function stripLeadingBullet(input: string): string {
  return input.replace(/^[^\p{L}\p{N}\s<]+\s*/u, "");
}

/**
 * Visible LENGTH of a FormattingNode array in code units (strip all tags).
 * Legacy measure retained for the modal `wrapNodes` callers. For terminal
 * layout prefer {@link nodeDisplayWidth} — code units overflow on wide glyphs.
 */
export function nodeVisibleLength(nodes: FormattingNode[]): number {
  return toPlainText(nodes).length;
}

/**
 * Visible DISPLAY WIDTH of a FormattingNode array in terminal columns, via the
 * real `string-width` oracle (CJK/wide = 2, combining/zero-width = 0, emoji by
 * rendered width). This is the measure the narrative layout engine wraps by.
 */
export function nodeDisplayWidth(nodes: FormattingNode[]): number {
  return stringWidth(toPlainText(nodes));
}

/**
 * Word-wrap an AST node array at the given width.
 * Returns an array of lines, each a well-formed FormattingNode[].
 * Tags never break across lines — this eliminates the need for healTagBoundaries.
 */
export function wrapNodes(nodes: FormattingNode[], width: number): FormattingNode[][] {
  if (width <= 0) return [nodes];

  // Single top-level alignment tag → never wrap
  if (nodes.length === 1 && typeof nodes[0] !== "string"
      && (nodes[0].type === "center" || nodes[0].type === "right")) {
    return [nodes];
  }

  // Fast path: fits already
  if (nodeVisibleLength(nodes) <= width) return [nodes];

  // Flatten the node tree into word tokens. Each word carries a well-formed
  // node fragment so reconstructed lines are structurally valid.
  interface WordToken { nodes: FormattingNode[]; visible: number; }
  const words: WordToken[] = [];

  // Collect all words by depth-first walk
  flattenToWords(nodes, words);

  if (words.length === 0) return [nodes];

  // Greedily assemble words into lines
  const lines: FormattingNode[][] = [];
  let curLine: FormattingNode[] = [];
  let curVis = 0;

  for (const word of words) {

    if (curVis > 0 && curVis + 1 + word.visible > width) {
      // Start a new line
      lines.push(curLine);
      curLine = [];
      curVis = 0;
    }

    // Add space between words on the same line
    if (curVis > 0) {
      curLine.push(" ");
      curVis += 1;
    }

    curLine.push(...word.nodes);
    curVis += word.visible;
  }

  if (curLine.length > 0) {
    lines.push(curLine);
  }

  return lines.length > 0 ? lines : [nodes];
}

/**
 * Flatten a FormattingNode[] into word tokens, splitting text at spaces.
 * Each word token carries structurally well-formed node fragments.
 * Returns true if the last text ended with a space (trailing word break).
 *
 * Exported for the narrative layout engine (`narrative/layout.ts`), which reuses
 * this proven tokenizer (spacing + wikilink atomicity) but re-measures each word
 * by display width and adds overlong-token breaking.
 */
export function flattenToWords(
  nodes: FormattingNode[],
  words: { nodes: FormattingNode[]; visible: number }[],
): boolean {
  let wordBreak = false;

  for (const node of nodes) {
    if (typeof node === "string") {
      // Split text node at spaces into words
      const parts = node.split(/ /);
      wordBreak = false;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i > 0) {
          // Space boundary — we've consumed a space
          wordBreak = true;
          if (part === "") continue;
          words.push({ nodes: [part], visible: part.length });
          wordBreak = false;
        } else {
          // First part — append to current word-in-progress or start new
          if (part === "") { wordBreak = true; continue; }
          if (words.length > 0 && !wordBreak) {
            // Append to previous word (continuation across tag boundaries)
            const prev = words[words.length - 1];
            prev.nodes.push(part);
            prev.visible += part.length;
          } else {
            words.push({ nodes: [part], visible: part.length });
          }
          wordBreak = false;
        }
      }
    } else if (node.type === "wikilink") {
      // Wikilinks are atomic at wrap time: a `[[Two Word]]` link must render
      // as one contiguous span (splitting it would visually break the link
      // and also produces two AST fragments that downstream collectors
      // would double-count). Emit the whole tag as a single word token.
      const visible = nodeVisibleLength(node.content);
      if (visible === 0) continue;
      if (words.length > 0 && !wordBreak) {
        const prev = words[words.length - 1];
        prev.nodes.push(node);
        prev.visible += visible;
      } else {
        words.push({ nodes: [node], visible });
      }
      wordBreak = false;
    } else if (node.type === "linebreak") {
      // wrapNodes is the legacy single-line wrapper (modal callers); hard breaks
      // don't occur on that path. If one ever appears, treat it as a word
      // boundary so adjacent text doesn't fuse. The narrative path handles
      // linebreaks structurally in the layout engine, not here.
      wordBreak = true;
    } else {
      // Tag node — recurse into children, wrapping fragments in the same tag type
      const childWords: { nodes: FormattingNode[]; visible: number }[] = [];
      const childBreak = flattenToWords(node.content, childWords);

      for (let i = 0; i < childWords.length; i++) {
        const cw = childWords[i];
        // Wrap each child word fragment in a copy of this tag
        const wrapped: FormattingTag = { ...node, content: cw.nodes } as FormattingTag;

        if (i === 0 && words.length > 0 && !wordBreak) {
          // First fragment continues the previous word
          const prev = words[words.length - 1];
          prev.nodes.push(wrapped);
          prev.visible += cw.visible;
        } else {
          words.push({ nodes: [wrapped], visible: cw.visible });
        }
      }
      // Propagate trailing word break from child content
      wordBreak = childBreak;
    }
  }

  return wordBreak;
}

/**
 * Test whether a raw text line is a legal Markdown horizontal rule.
 * Matches 3+ of the same character (-, *, _) with optional spaces.
 */
export function isHorizontalRule(text: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text);
}

/**
 * If a DM line ends with a horizontal rule glued to narrative text
 * (e.g. "You drive home.---"), return the prefix text. Returns null when
 * no trailing rule is present. The rule must be 3+ adjacent identical
 * chars (-, *, _); whitespace between the prefix and rule is permitted.
 *
 * Returns null for whole-line rules — those are the caller's job to
 * detect via isHorizontalRule(). Without this guard, an input like
 * "----" would match with the lazy prefix consuming the first `-`,
 * producing "-" as the bogus prefix.
 */
export function splitTrailingHorizontalRule(text: string): string | null {
  if (isHorizontalRule(text)) return null;
  const m = text.match(/^(.*?\S)\s*([-*_])\2{2,}\s*$/);
  return m ? m[1] : null;
}

/**
 * Unified processing pipeline for NarrativeLines.
 * Heal → parse → wrap → pad alignment → quote highlight.
 * Returns ProcessedLine[] ready for direct rendering.
 */
export function processNarrativeLines(
  lines: NarrativeLine[],
  width: number,
  quoteColor?: string,
): ProcessedLine[] {
  // Phase 0: Split inline <center> and <right> blocks onto their own lines.
  // The rendering pipeline expects these to be the sole content of a line.
  // Also converts DM horizontal rules (---, ***, ___) into separator lines,
  // including rules glued to the end of a narrative line ("text.---").
  // Adjacent separators (with only spacer/empty-dm padding between) collapse
  // to one — multiple sources can emit a separator for the same turn boundary
  // (e.g. on session resume, the disk's "---" markers are streamed as DM
  // chunks AND the client injects a separator before the first DM chunk
  // after a player line).
  // Pre-pass: rewrite each DM line's dialect (semantic HTML, attribute variants,
  // inline markdown) into the canonical vocabulary before healing/parsing, so the
  // heal and parse stages only ever see the closed tag set.
  const normLines: NarrativeLine[] = lines.map((l) =>
    l.kind === "dm" && l.text !== "" ? { ...l, text: normalizeDialect(l.text) } : l,
  );

  const expandedLines: NarrativeLine[] = [];
  for (const srcLine of normLines) {
    if (srcLine.kind === "dm" && srcLine.text.trim() !== "") {
      if (isHorizontalRule(srcLine.text)) {
        pushSeparator(expandedLines);
      } else {
        const trailingPrefix = splitTrailingHorizontalRule(srcLine.text);
        const text = trailingPrefix ?? srcLine.text;
        const split = splitAlignmentBlocks(text);
        for (const part of split) {
          expandedLines.push({ kind: "dm", text: part });
        }
        if (trailingPrefix !== null) {
          pushSeparator(expandedLines);
        }
      }
    } else if (srcLine.kind === "separator") {
      pushSeparator(expandedLines, srcLine);
    } else {
      expandedLines.push(srcLine);
    }
  }

  // Phase 1: Heal cross-line tags on raw strings, then parse into AST.
  // Healing must happen before parsing because parseFormatting treats
  // unclosed tags as plain text.
  const parsed: { kind: NarrativeLine["kind"]; nodes: FormattingNode[]; isSourceBoundary: boolean; intent?: Extract<NarrativeLine, { kind: "image" }>["intent"] }[] = [];

  // Track open tags across DM source lines for cross-line healing
  const openStack: { raw: string; name: string }[] = [];

  for (const srcLine of expandedLines) {
    if (srcLine.kind !== "dm") {
      parsed.push({
        kind: srcLine.kind,
        nodes: [srcLine.text],
        isSourceBoundary: true,
        // Carry image framing intent through the pipeline (only image lines have it).
        ...(srcLine.kind === "image" ? { intent: srcLine.intent } : {}),
      });
      continue;
    }

    // At paragraph boundaries (blank DM lines), reset all open tags.
    // All tags (b/i/u/color/center/right) persist across non-blank source lines.
    // Visual spacers inserted by appendDelta use kind "spacer" and skip healing
    // entirely, so tags also persist across single \n line breaks.
    if (srcLine.text.trim() === "") {
      openStack.length = 0;
    }

    // Scan the original text for tag changes
    const changes = scanTagChanges(srcLine.text);

    // Build prefix from currently open tags
    const prefix = openStack.map((t) => t.raw).join("");

    // Apply changes to the stack
    for (const change of changes) {
      if (change.kind === "open") {
        openStack.push({ raw: change.raw, name: change.name });
      } else {
        for (let j = openStack.length - 1; j >= 0; j--) {
          if (openStack[j].name === change.name) {
            openStack.splice(j, 1);
            break;
          }
        }
      }
    }

    // Build suffix: close anything still open
    const suffix = [...openStack]
      .reverse()
      .map((t) => `</${t.name}>`)
      .join("");

    // Heal the raw text, then parse into AST
    const healedText = prefix + srcLine.text + suffix;
    const nodes = parseFormatting(healedText);

    parsed.push({ kind: "dm", nodes, isSourceBoundary: true });
  }

  // Phase 2: Lay out each line into physical rows by DISPLAY width. Aligned
  // blocks wrap their inner content and split on <br> into independent rows, each
  // emitted as its own single-tag aligned line; every row fits `width` (INV-WIDTH).
  const wrapped: { kind: NarrativeLine["kind"]; nodes: FormattingNode[]; isSourceBoundary: boolean; intent?: Extract<NarrativeLine, { kind: "image" }>["intent"] }[] = [];
  for (const line of parsed) {
    const first = line.nodes[0];
    if (line.kind === "dm" && line.nodes.length === 1 && typeof first !== "string"
        && (first.type === "center" || first.type === "right")) {
      // Aligned block: wrap + split-on-<br> the inner content; re-wrap each row
      // in the alignment tag so it stays a single-node aligned line.
      const rows = layoutRuns(first.content, width);
      for (let j = 0; j < rows.length; j++) {
        wrapped.push({ kind: "dm", nodes: [{ ...first, content: rows[j] }], isSourceBoundary: j === 0 });
      }
    } else if (line.kind === "dm") {
      const rows = layoutRuns(line.nodes, width);
      for (let j = 0; j < rows.length; j++) {
        wrapped.push({ kind: "dm", nodes: rows[j], isSourceBoundary: j === 0 });
      }
    } else if (line.kind === "player") {
      // Player nodes are always plain strings — re-join after wrapping so the
      // renderer can still read nodes[0] as the full line text.
      const rows = layoutRuns(line.nodes, width);
      for (let j = 0; j < rows.length; j++) {
        wrapped.push({ kind: "player", nodes: [toPlainText(rows[j])], isSourceBoundary: j === 0 });
      }
    } else {
      wrapped.push(line);
    }
  }

  // Phase 3: Pad alignment lines
  const padded: { kind: NarrativeLine["kind"]; nodes: FormattingNode[]; isSourceBoundary: boolean; intent?: Extract<NarrativeLine, { kind: "image" }>["intent"] }[] = [];
  for (let i = 0; i < wrapped.length; i++) {
    const line = wrapped[i];
    const isAlign = line.kind === "dm" && isAlignmentNode(line.nodes);

    if (isAlign) {
      // Blank line before the aligned GROUP if the previous line is non-empty
      // and not itself aligned (consecutive aligned rows — e.g. a multi-line
      // <br> sign — must not get blanks between them).
      const prev = padded[padded.length - 1];
      const prevAlign = prev !== undefined && prev.kind === "dm" && isAlignmentNode(prev.nodes);
      if (prev !== undefined && !isEmptyNodes(prev.nodes) && !prevAlign) {
        padded.push({ kind: "dm", nodes: [], isSourceBoundary: false });
      }
      padded.push(line);
      // Blank line after if the next line is non-empty and not aligned.
      const next = wrapped[i + 1];
      const nextAlign = next !== undefined && next.kind === "dm" && isAlignmentNode(next.nodes);
      if (next !== undefined && !isEmptyNodes(next.nodes) && !nextAlign) {
        padded.push({ kind: "dm", nodes: [], isSourceBoundary: false });
      }
    } else {
      padded.push(line);
    }
  }

  // Phase 4: Quote highlighting with paragraph-scoped reset
  const result: ProcessedLine[] = [];
  let inQuote = false;

  for (const line of padded) {
    if (line.kind === "dm") {
      // Reset quote state at blank DM lines (paragraph boundary)
      if (isEmptyNodes(line.nodes)) {
        inQuote = false;
      }

      let nodes = line.nodes;
      if (quoteColor) {
        nodes = highlightQuotesWithState(nodes, quoteColor, inQuote);
        // Update quote state
        const plain = toPlainText(line.nodes);
        for (const ch of plain) {
          if (ch === '"') inQuote = !inQuote;
        }
      }

      // Detect alignment
      let alignment: "center" | "right" | undefined;
      if (line.nodes.length === 1 && typeof line.nodes[0] !== "string"
          && (line.nodes[0].type === "center" || line.nodes[0].type === "right")) {
        alignment = line.nodes[0].type;
      }

      result.push({ kind: "dm", nodes, alignment, ...(alignment ? { padWidth: width } : {}) });
    } else {
      result.push({
        kind: line.kind,
        nodes: line.nodes,
        ...(line.intent ? { intent: line.intent } : {}),
      });
    }
  }

  return result;
}

/**
 * Split a raw text line so that <center>...</center> and <right>...</right>
 * blocks each end up on their own line. Text before/after is preserved as
 * separate lines. If the line has no inline alignment blocks, returns [text].
 */
function splitAlignmentBlocks(text: string): string[] {
  const pattern = /(<(?:center|right)>[\s\S]*?<\/(?:center|right)>)/;
  const parts = text.split(pattern);
  const result: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) result.push(trimmed);
  }
  return result.length > 0 ? result : [text];
}

/**
 * Append a separator line, collapsing against an immediately-prior separator
 * (skipping `spacer` and empty-dm padding between them). Pass the original
 * source line when the separator came from a NarrativeLine of `kind: "separator"`
 * so its text/tag are preserved; omit it when the separator was synthesized
 * from a horizontal rule conversion.
 */
function pushSeparator(lines: NarrativeLine[], source?: NarrativeLine): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind === "spacer") continue;
    if (line.kind === "dm" && line.text === "") continue;
    if (line.kind === "separator") return;
    break;
  }
  lines.push(source && source.kind === "separator" ? source : { kind: "separator", text: "" });
}

function isAlignmentNode(nodes: FormattingNode[]): boolean {
  return nodes.length === 1 && typeof nodes[0] !== "string"
    && (nodes[0].type === "center" || nodes[0].type === "right");
}

function isEmptyNodes(nodes: FormattingNode[]): boolean {
  return nodes.length === 0 || (nodes.length === 1 && nodes[0] === "");
}



function splitQuotesWithState(
  text: string,
  color: string,
  startInQuote: boolean,
): FormattingNode[] {
  const result: FormattingNode[] = [];
  let inQuote = startInQuote;
  let current = "";

  for (const ch of text) {
    if (ch === '"') {
      if (inQuote) {
        // Closing quote — include the closing " in the quoted span
        current += ch;
        const quoteNode: FormattingTag = { type: "color", color, content: [current] };
        result.push(quoteNode);
        current = "";
        inQuote = false;
      } else {
        // Opening quote — flush plain text, start quote
        if (current) result.push(current);
        current = ch;
        inQuote = true;
      }
    } else {
      current += ch;
    }
  }

  // Flush remaining
  if (current) {
    if (inQuote) {
      // Line ends mid-quote — highlight the rest
      const quoteNode: FormattingTag = { type: "color", color, content: [current] };
      result.push(quoteNode);
    } else {
      result.push(current);
    }
  }

  return result.length > 0 ? result : [text];
}

export function highlightQuotesWithState(
  nodes: FormattingNode[],
  color: string,
  startInQuote: boolean,
): FormattingNode[] {
  const result: FormattingNode[] = [];
  let inQuote = startInQuote;
  for (const node of nodes) {
    if (typeof node === "string") {
      const expanded = splitQuotesWithState(node, color, inQuote);
      result.push(...expanded);
      // Update state: count quotes in this text
      for (const ch of node) if (ch === '"') inQuote = !inQuote;
    } else if (node.type === "linebreak") {
      result.push(node); // contentless leaf — no quote state to thread
    } else {
      const newContent = highlightQuotesWithState(node.content, color, inQuote);
      result.push({ ...node, content: newContent } as FormattingTag);
      // Update state from tag's text content
      const plain = toPlainText(node.content);
      for (const ch of plain) if (ch === '"') inQuote = !inQuote;
    }
  }
  return result;
}



interface TagChange {
  kind: "open" | "close";
  name: string;
  raw: string; // full tag text, e.g. "<color=#ff0000>" or "</i>"
}

/**
 * Scan a line for open/close formatting tags, returning them in order.
 * Does not parse content — just finds tag boundaries for stack tracking.
 */
function scanTagChanges(line: string): TagChange[] {
  const changes: TagChange[] = [];
  let i = 0;

  while (i < line.length) {
    const tagStart = line.indexOf("<", i);
    if (tagStart === -1) break;

    // Try close tag first: </tagname>
    const closeMatch = line.slice(tagStart).match(/^<\/(b|i|u|sub|sup|center|right|color|wikilink|code)>/);
    if (closeMatch) {
      changes.push({ kind: "close", name: closeMatch[1], raw: closeMatch[0] });
      i = tagStart + closeMatch[0].length;
      continue;
    }

    // Try open tag via parseOpenTag (reuses existing logic)
    const parsed = parseOpenTag(line, tagStart);
    if (parsed) {
      // Void tags (<br>) are self-contained — they never open a span, so they
      // must not push onto the heal stack (else healing would emit a bogus
      // </br> closer).
      if (parsed.void) {
        i = parsed.end;
        continue;
      }
      changes.push({ kind: "open", name: parsed.tagName, raw: line.slice(tagStart, parsed.end) });
      i = parsed.end;
      continue;
    }

    // Not a recognized tag, skip past <
    i = tagStart + 1;
  }

  return changes;
}

/**
 * Convert a single markdown line into our <b>/<i>/<color> tag format.
 * This lets markdown content flow through the existing parseFormatting pipeline.
 *
 * Conversions:
 *  - ## Header → <b>Header</b>  (any heading level)
 *  - **bold** → <b>bold</b>
 *  - *italic* → <i>italic</i>  (but not **)
 *  - [text](url) → text  (strip to display text)
 *  - - list item → · list item  (visual bullet)
 *  - Everything else → pass through
 */
export function markdownToTags(line: string): string {
  // Heading lines: ## Header Text → <b>Header Text</b>
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return `<b>${headingMatch[2]}</b>`;
  }

  // List items: - item → · item (preserve nesting indent only)
  const listMatch = line.match(/^(\s*)-\s+(.+)$/);
  if (listMatch) {
    const indent = listMatch[1];
    line = `${indent}· ${listMatch[2]}`;
  }

  // Links: [text](url) → text
  line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Bold: **text** → <b>text</b> (must come before italic)
  line = line.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* → <i>text</i> (single *, not preceded/followed by *)
  line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  return line;
}









// --- Internal ---

interface ParsedTag {
  tagName: string;
  type: string;
  color?: string;
  target?: string;
  void?: boolean; // self-contained leaf (e.g. <br>) — no closing tag
  end: number; // index after the closing >
}

// A tag-shaped run to strip: `<name>`, `</name>`, `<name/>`, or an attributed
// `<name key="v" …>` (an attribute section is required to contain `=`). Matches
// unknown opens (<strong>, <h2>, <b class="x">, <span style="…">) and any close
// (</foo>). Deliberately does NOT match prose that merely contains angle
// brackets — `3 < 5` (space after `<`), `<3` (digit), or `i<j and j>k`
// (bareword "attributes" with no `=`) all stay literal.
const GENERIC_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9]*\s*(?:\/?>|[^<>]*=[^<>]*>)/;

const SIMPLE_TAGS: Record<string, string> = {
  b: "bold",
  i: "italic",
  u: "underline",
  sub: "subscript",
  sup: "superscript",
  center: "center",
  right: "right",
  code: "code",
};

function parseOpenTag(input: string, start: number): ParsedTag | null {
  // Match <tagname> or <color=#hex>
  const remaining = input.slice(start);

  // Simple paired tags: <b>, <i>, <u>, <sub>, <sup>, <center>, <right>, <code>
  const simpleMatch = remaining.match(/^<(b|i|u|sub|sup|center|right|code)>/);
  if (simpleMatch) {
    const tagName = simpleMatch[1];
    return {
      tagName,
      type: SIMPLE_TAGS[tagName],
      end: start + simpleMatch[0].length,
    };
  }

  // Void tag: <br> / <br/> / <br /> → a hard line-break leaf.
  const brMatch = remaining.match(/^<br\s*\/?>/);
  if (brMatch) {
    return { tagName: "br", type: "linebreak", void: true, end: start + brMatch[0].length };
  }

  // Color tag: <color=#hex>
  const colorMatch = remaining.match(/^<color=(#[0-9a-fA-F]{3,8})>/);
  if (colorMatch) {
    return {
      tagName: "color",
      type: "color",
      color: colorMatch[1],
      end: start + colorMatch[0].length,
    };
  }

  // Wikilink tag: <wikilink slug=foo-bar>. Slug accepts the slugify charset
  // (lowercase letters, digits, hyphens) — strict to keep parsing unambiguous.
  const wikiMatch = remaining.match(/^<wikilink slug=([a-z0-9-]+)>/);
  if (wikiMatch) {
    return {
      tagName: "wikilink",
      type: "wikilink",
      target: wikiMatch[1],
      end: start + wikiMatch[0].length,
    };
  }

  return null;
}

function findClosingTag(input: string, startAfter: number, tagName: string): number {
  const closeTag = `</${tagName}>`;
  const openTag = `<${tagName}`;

  let depth = 1;
  let pos = startAfter;

  while (pos < input.length) {
    const nextClose = input.indexOf(closeTag, pos);
    if (nextClose === -1) return -1;

    // Count any nested opens before this close
    let searchPos = pos;
    while (searchPos < nextClose) {
      const nextOpen = input.indexOf(openTag, searchPos);
      if (nextOpen === -1 || nextOpen >= nextClose) break;
      // The match is a real nested open of THIS tag only if the char after the
      // name is a tag terminator. Without this, counting `<b>` would treat the
      // unrelated `<br>` as a nested open (the "<b" prefix matches) and never
      // balance — leaking the `<b>` as literal text.
      const after = input[nextOpen + openTag.length];
      const isRealOpen = after === ">" || after === " " || after === "/" || after === "=";
      if (!isRealOpen) {
        searchPos = nextOpen + openTag.length;
        continue;
      }
      // Verify it's a complete open tag (ends with >)
      const afterOpen = input.indexOf(">", nextOpen);
      if (afterOpen !== -1 && afterOpen < nextClose) {
        depth++;
        searchPos = afterOpen + 1;
      } else {
        break;
      }
    }

    depth--;
    if (depth === 0) return nextClose;
    pos = nextClose + closeTag.length;
  }

  return -1;
}

function buildNode(
  type: string,
  color: string | undefined,
  target: string | undefined,
  children: FormattingNode[],
): FormattingTag | null {
  switch (type) {
    case "bold":
      return { type: "bold", content: children };
    case "italic":
      return { type: "italic", content: children };
    case "underline":
      return { type: "underline", content: children };
    case "code":
      return { type: "code", content: children };
    case "subscript":
      return { type: "subscript", content: children };
    case "superscript":
      return { type: "superscript", content: children };
    case "center":
      return { type: "center", content: children };
    case "right":
      return { type: "right", content: children };
    case "color":
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- color is set when tag === "color"
      return { type: "color", color: color!, content: children };
    case "wikilink":
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- target is set when tag === "wikilink"
      return { type: "wikilink", target: target!, content: children };
    default:
      return null;
  }
}

function pushText(nodes: FormattingNode[], text: string): void {
  if (text.length === 0) return;
  // Merge with previous text node if possible
  const last = nodes[nodes.length - 1];
  if (typeof last === "string") {
    nodes[nodes.length - 1] = last + text;
  } else {
    nodes.push(text);
  }
}
