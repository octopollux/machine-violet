import type { FormattingNode, FormattingTag, NarrativeLine } from "../types/tui.js";

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
 * Track quote state across multiple lines for multiline quote highlighting.
 * Returns an array of booleans indicating whether each line ends inside an open quote.
 */
export function computeQuoteState(lines: NarrativeLine[]): boolean[] {
  const states: boolean[] = [];
  let inQuote = false;

  for (const line of lines) {
    if (line.kind === "dm") {
      for (const ch of line.text) {
        if (ch === '"') {
          inQuote = !inQuote;
        }
      }
    }
    states.push(inQuote);
  }

  return states;
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

/**
 * Heal formatting tags that span line boundaries.
 *
 * When a tag like `<i>` is opened on one line and closed on a later line,
 * per-line parsing sees unclosed/orphaned tags. This function prepends
 * inherited open tags and appends close tags so each line is well-formed.
 */
export function healTagBoundaries(lines: string[]): string[] {
  const openStack: { raw: string; name: string }[] = [];
  const healed: string[] = [];

  for (const line of lines) {
    // Compute tag changes from the *original* line
    const changes = scanTagChanges(line);

    // Build prefix from currently open tags
    const prefix = openStack.map((t) => t.raw).join("");

    // Apply changes to the stack
    for (const change of changes) {
      if (change.kind === "open") {
        openStack.push({ raw: change.raw, name: change.name });
      } else {
        // Close: pop the most recent matching open tag
        for (let j = openStack.length - 1; j >= 0; j--) {
          if (openStack[j].name === change.name) {
            openStack.splice(j, 1);
            break;
          }
        }
      }
    }

    // Suffix: close anything still open (reversed for proper nesting)
    const suffix = [...openStack]
      .reverse()
      .map((t) => `</${t.name}>`)
      .join("");

    healed.push(prefix + line + suffix);
  }

  return healed;
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
export function scanTagChanges(line: string): TagChange[] {
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

/**
 * Insert blank lines before/after alignment lines (<center>, <right>)
 * so they have breathing room. Skips if a blank line is already present.
 */
export function padAlignmentLines(lines: NarrativeLine[]): NarrativeLine[] {
  const alignRe = /^\s*<(center|right)>.*<\/\1>\s*$/;
  const result: NarrativeLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const isAlign = lines[i].kind === "dm" && alignRe.test(lines[i].text);

    if (isAlign) {
      // Insert blank line before if previous line is non-empty
      const prev = result[result.length - 1];
      if (prev !== undefined && prev.text !== "") {
        result.push({ kind: "dm", text: "" });
      }
      result.push(lines[i]);
      // Insert blank line after if next line is non-empty
      const next = lines[i + 1];
      if (next !== undefined && next.text !== "") {
        result.push({ kind: "dm", text: "" });
      }
    } else {
      result.push(lines[i]);
    }
  }

  return result;
}

/**
 * Count visible characters in a string, skipping recognized formatting tags.
 * Tags like <b>, </b>, <color=#hex>, </color>, <i>, </i>, <u>, </u>,
 * <center>, </center>, <right>, </right> are zero-width.
 */
export function visibleLength(text: string): number {
  let len = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === "<") {
      // Try close tag
      const closeMatch = text.slice(i).match(/^<\/(b|i|u|center|right|color)>/);
      if (closeMatch) {
        i += closeMatch[0].length;
        continue;
      }
      // Try open tag
      const parsed = parseOpenTag(text, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    len++;
    i++;
  }

  return len;
}

/**
 * Tag-aware word wrap for a single source line.
 * Splits at word boundaries (spaces) when visible length exceeds width.
 * Tags are zero-width and never split. Alignment lines are never wrapped.
 * Returns the line unchanged (in a single-element array) if it fits.
 */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [text];

  // Skip alignment lines — never wrap those
  if (/^\s*<(center|right)>.*<\/\1>\s*$/.test(text)) return [text];

  // Fast path: fits already
  if (visibleLength(text) <= width) return [text];

  // Tokenize into segments: each is either a tag (zero-width) or a single visible char
  interface Segment { text: string; visible: number; isSpace: boolean; }
  const segments: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const closeMatch = text.slice(i).match(/^<\/(b|i|u|center|right|color)>/);
      if (closeMatch) {
        segments.push({ text: closeMatch[0], visible: 0, isSpace: false });
        i += closeMatch[0].length;
        continue;
      }
      const parsed = parseOpenTag(text, i);
      if (parsed) {
        segments.push({ text: text.slice(i, parsed.end), visible: 0, isSpace: false });
        i = parsed.end;
        continue;
      }
    }
    const ch = text[i];
    segments.push({ text: ch, visible: 1, isSpace: ch === " " });
    i++;
  }

  // Group segments into words (split at spaces; spaces attach to preceding word)
  interface Word { text: string; visible: number; }
  const words: Word[] = [];
  let cur: Word = { text: "", visible: 0 };

  for (const seg of segments) {
    cur.text += seg.text;
    cur.visible += seg.visible;
    if (seg.isSpace) {
      words.push(cur);
      cur = { text: "", visible: 0 };
    }
  }
  if (cur.text !== "") words.push(cur);

  // Build lines from words
  const result: string[] = [];
  let line = "";
  let lineVis = 0;

  for (const word of words) {
    if (lineVis > 0 && lineVis + word.visible > width) {
      // Trim trailing space from line before pushing
      result.push(line.replace(/ $/, ""));
      line = "";
      lineVis = 0;
    }

    // Hard break: word alone exceeds width and line is empty
    if (lineVis === 0 && word.visible > width) {
      // Just let it through — it'll exceed width but we can't split mid-word cleanly with tags
      line += word.text;
      lineVis += word.visible;
      continue;
    }

    line += word.text;
    lineVis += word.visible;
  }

  if (line !== "") {
    result.push(line.replace(/ $/, ""));
  }

  return result.length > 0 ? result : [text];
}

/**
 * Combined wrap + heal pipeline.
 * 1. Pre-wraps each source line at terminal width (tag-aware)
 * 2. Heals tag boundaries across all visual lines
 * 3. Resets `color` from the propagation stack at source-line boundaries
 * 4. `b`/`i`/`u` persist across all boundaries; `color` only across wrap boundaries
 */
export function wrapAndHealLines(lines: NarrativeLine[], width: number): NarrativeLine[] {
  // Phase 1: wrap each source line into visual lines, tracking source boundaries and kinds
  const visualLines: NarrativeLine[] = [];
  const isSourceBoundary: boolean[] = [];

  for (const srcLine of lines) {
    if (srcLine.kind === "dm" || srcLine.kind === "dev") {
      const wrapped = width > 0 ? wrapLine(srcLine.text, width) : [srcLine.text];
      for (let j = 0; j < wrapped.length; j++) {
        visualLines.push({ kind: srcLine.kind, text: wrapped[j] });
        isSourceBoundary.push(j === 0);
      }
    } else {
      // player/system lines pass through without tag-aware wrapping
      visualLines.push(srcLine);
      isSourceBoundary.push(true);
    }
  }

  // Phase 2: heal only dm lines; non-dm lines pass through without touching the stack
  const openStack: { raw: string; name: string }[] = [];
  const healed: NarrativeLine[] = [];

  for (let i = 0; i < visualLines.length; i++) {
    if (visualLines[i].kind !== "dm") {
      healed.push(visualLines[i]);
      continue;
    }

    // At source boundaries, remove color entries from the stack
    if (isSourceBoundary[i]) {
      for (let j = openStack.length - 1; j >= 0; j--) {
        if (openStack[j].name === "color") {
          openStack.splice(j, 1);
        }
      }
    }

    const line = visualLines[i].text;
    const changes = scanTagChanges(line);

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

    // Suffix: close anything still open
    const suffix = [...openStack]
      .reverse()
      .map((t) => `</${t.name}>`)
      .join("");

    healed.push({ kind: "dm", text: prefix + line + suffix });
  }

  return healed;
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
