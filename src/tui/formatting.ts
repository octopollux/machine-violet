import type { FormattingNode, FormattingTag, NarrativeLine, ProcessedLine } from "../types/tui.js";

/**
 * Parse DM text with inline formatting tags into a tree of FormattingNodes.
 *
 * Supported tags: <b>, <i>, <u>, <center>, <right>, <color=#hex>
 * Unrecognized tags are stripped. Malformed tags render as plain text.
 * Tags can be nested: <b><i>bold italic</i></b>
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
      // Not a valid tag — treat the < as plain text
      pushText(result, "<");
      i = tagStart + 1;
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

    const node = buildNode(parsed.type, parsed.color, children);
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
      return toPlainText(node.content);
    })
    .join("");
}

/**
 * Compute the visible length of a FormattingNode array (strip all tags).
 */
export function nodeVisibleLength(nodes: FormattingNode[]): number {
  return toPlainText(nodes).length;
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

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

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
 */
function flattenToWords(
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
 * Unified processing pipeline for NarrativeLines.
 * Heal → parse → wrap → pad alignment → quote highlight.
 * Returns ProcessedLine[] ready for direct rendering.
 */
export function processNarrativeLines(
  lines: NarrativeLine[],
  width: number,
  quoteColor?: string,
): ProcessedLine[] {
  // Phase 1: Heal cross-line tags on raw strings, then parse into AST.
  // Healing must happen before parsing because parseFormatting treats
  // unclosed tags as plain text.
  const parsed: { kind: NarrativeLine["kind"]; nodes: FormattingNode[]; isSourceBoundary: boolean }[] = [];

  // Track open tags across DM source lines for cross-line healing
  const openStack: { raw: string; name: string }[] = [];

  for (const srcLine of lines) {
    if (srcLine.kind !== "dm") {
      parsed.push({ kind: srcLine.kind, nodes: [srcLine.text], isSourceBoundary: true });
      continue;
    }

    // At paragraph boundaries (blank DM lines), reset all open tags.
    // At other source boundaries, reset only color tags (b/i/u persist within a paragraph).
    if (srcLine.text.trim() === "") {
      openStack.length = 0;
    } else {
      for (let j = openStack.length - 1; j >= 0; j--) {
        if (openStack[j].name === "color") {
          openStack.splice(j, 1);
        }
      }
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

  // Phase 2: Wrap each line
  const wrapped: { kind: NarrativeLine["kind"]; nodes: FormattingNode[]; isSourceBoundary: boolean }[] = [];
  for (const line of parsed) {
    if (line.kind === "dm" || line.kind === "player") {
      const wLines = wrapNodes(line.nodes, width);
      for (let j = 0; j < wLines.length; j++) {
        if (line.kind === "player") {
          // Player nodes are always plain strings — re-join after wrapping
          // so the renderer can still read nodes[0] as the full line text.
          wrapped.push({ kind: "player", nodes: [toPlainText(wLines[j])], isSourceBoundary: j === 0 });
        } else {
          wrapped.push({ kind: "dm", nodes: wLines[j], isSourceBoundary: j === 0 });
        }
      }
    } else {
      wrapped.push(line);
    }
  }

  // Phase 3: Pad alignment lines
  const padded: { kind: NarrativeLine["kind"]; nodes: FormattingNode[]; isSourceBoundary: boolean }[] = [];
  for (let i = 0; i < wrapped.length; i++) {
    const line = wrapped[i];
    const isAlign = line.kind === "dm" && isAlignmentNode(line.nodes);

    if (isAlign) {
      // Blank line before if previous is non-empty
      const prev = padded[padded.length - 1];
      if (prev !== undefined && !isEmptyNodes(prev.nodes)) {
        padded.push({ kind: "dm", nodes: [], isSourceBoundary: false });
      }
      padded.push(line);
      // Blank line after if next is non-empty
      const next = wrapped[i + 1];
      if (next !== undefined && !isEmptyNodes(next.nodes)) {
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

      result.push({ kind: "dm", nodes, alignment });
    } else {
      result.push({ kind: line.kind, nodes: line.nodes });
    }
  }

  // Phase 5: Turn separators — ensure a blank line at kind transitions
  // (e.g. DM→player, player→DM). Skip if the previous output line is
  // already blank so we never double-up on existing paragraph breaks.
  const separated: ProcessedLine[] = [];
  for (let i = 0; i < result.length; i++) {
    if (i > 0 && result[i].kind !== result[i - 1].kind) {
      const prev = separated[separated.length - 1];
      if (prev && !isEmptyProcessedLine(prev)) {
        separated.push({ kind: result[i].kind, nodes: [] });
      }
    }
    separated.push(result[i]);
  }

  return separated;
}

function isEmptyProcessedLine(line: ProcessedLine): boolean {
  return isEmptyNodes(line.nodes);
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
    const closeMatch = line.slice(tagStart).match(/^<\/(b|i|u|center|right|color)>/);
    if (closeMatch) {
      changes.push({ kind: "close", name: closeMatch[1], raw: closeMatch[0] });
      i = tagStart + closeMatch[0].length;
      continue;
    }

    // Try open tag via parseOpenTag (reuses existing logic)
    const parsed = parseOpenTag(line, tagStart);
    if (parsed) {
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
 *  - - list item → ·  list item  (visual bullet)
 *  - Everything else → pass through
 */
export function markdownToTags(line: string): string {
  // Heading lines: ## Header Text → <b>Header Text</b>
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return `<b>${headingMatch[2]}</b>`;
  }

  // List items: - item → ·  item (with indent)
  const listMatch = line.match(/^(\s*)-\s+(.+)$/);
  if (listMatch) {
    const indent = listMatch[1];
    line = `${indent}  · ${listMatch[2]}`;
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
  end: number; // index after the closing >
}

const SIMPLE_TAGS: Record<string, string> = {
  b: "bold",
  i: "italic",
  u: "underline",
  center: "center",
  right: "right",
};

function parseOpenTag(input: string, start: number): ParsedTag | null {
  // Match <tagname> or <color=#hex>
  const remaining = input.slice(start);

  // Simple tags: <b>, <i>, <u>, <center>, <right>
  const simpleMatch = remaining.match(/^<(b|i|u|center|right)>/);
  if (simpleMatch) {
    const tagName = simpleMatch[1];
    return {
      tagName,
      type: SIMPLE_TAGS[tagName],
      end: start + simpleMatch[0].length,
    };
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
  children: FormattingNode[],
): FormattingTag | null {
  switch (type) {
    case "bold":
      return { type: "bold", content: children };
    case "italic":
      return { type: "italic", content: children };
    case "underline":
      return { type: "underline", content: children };
    case "center":
      return { type: "center", content: children };
    case "right":
      return { type: "right", content: children };
    case "color":
      return { type: "color", color: color!, content: children };
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
