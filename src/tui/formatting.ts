import type { FormattingNode, FormattingTag } from "../types/tui.js";

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
 * Highlight quoted text ("...") in a formatting tree.
 * Wraps matched quotes in a color node. Uses the given color,
 * or defaults to bright white.
 */
export function highlightQuotes(
  nodes: FormattingNode[],
  color = "#ffffff",
): FormattingNode[] {
  return nodes.map((node) => {
    if (typeof node === "string") {
      return splitQuotes(node, color);
    }
    // Recurse into tag children
    return { ...node, content: highlightQuotes(node.content, color) } as FormattingTag;
  }).flat();
}

function splitQuotes(text: string, color: string): FormattingNode[] {
  const result: FormattingNode[] = [];
  const regex = /"([^"]+)"/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before the quote
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    // The quoted text (including quotes) as a color node
    const quoteNode: FormattingTag = {
      type: "color",
      color,
      content: [match[0]],
    };
    result.push(quoteNode);
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result.length > 0 ? result : [text];
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
