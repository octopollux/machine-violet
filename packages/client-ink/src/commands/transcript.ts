/**
 * Build an HTML transcript from the live narrative lines.
 *
 * Renders FormattingNode trees into inline-styled HTML that visually
 * matches the TUI output. The HTML is self-contained (inlined CSS,
 * no external dependencies) and opens cleanly in any browser.
 */
import type { NarrativeLine, FormattingNode, FormattingTag, ProcessedLine } from "@machine-violet/shared/types/tui.js";
import type { ThemeAsset } from "../tui/themes/types.js";
import { processNarrativeLines } from "../tui/formatting.js";
import { composeTurnSeparator } from "../tui/themes/composer.js";

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// FormattingNode[] → HTML
// ---------------------------------------------------------------------------

function nodeToHtml(node: FormattingNode): string {
  if (typeof node === "string") return esc(node);
  return tagToHtml(node);
}

function tagToHtml(tag: FormattingTag): string {
  const inner = tag.content.map(nodeToHtml).join("");
  switch (tag.type) {
    case "bold":
      return `<b>${inner}</b>`;
    case "italic":
      return `<i>${inner}</i>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "color":
      return `<span style="color:${esc(tag.color)}">${inner}</span>`;
    case "center":
    case "right":
      // Alignment handled at line level; if nested, just render inline
      return inner;
  }
}

function nodesToHtml(nodes: FormattingNode[]): string {
  return nodes.map(nodeToHtml).join("");
}

// ---------------------------------------------------------------------------
// ProcessedLine → HTML <div>
// ---------------------------------------------------------------------------

function lineToHtml(
  line: ProcessedLine,
  opts: { separatorText: string; separatorColor: string; playerColor: string },
): string {
  const isEmpty =
    line.nodes.length === 0 ||
    (line.nodes.length === 1 && line.nodes[0] === "");

  switch (line.kind) {
    case "spacer":
      return `<div class="spacer">&nbsp;</div>`;

    case "separator":
      return `<div class="separator" style="color:${esc(opts.separatorColor)}">${esc(opts.separatorText)}</div>`;

    case "dev":
      return ""; // dev lines omitted from export

    case "system": {
      const text = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      return `<div class="system">${esc(text)}</div>`;
    }

    case "player": {
      const text = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      if (text.startsWith("> ")) {
        return `<div class="player" style="color:${esc(opts.playerColor)}"><span class="prompt">&gt;</span>${esc(text.slice(1))}</div>`;
      }
      return `<div class="player" style="color:${esc(opts.playerColor)}">${esc(text)}</div>`;
    }

    case "dm": {
      if (isEmpty) return `<div class="dm">&nbsp;</div>`;
      if (line.alignment) {
        const align = line.alignment === "center" ? "center" : "right";
        const inner =
          line.nodes.length === 1 && typeof line.nodes[0] !== "string"
            ? line.nodes[0].content
            : line.nodes;
        return `<div class="dm" style="text-align:${align}">${nodesToHtml(inner)}</div>`;
      }
      return `<div class="dm">${nodesToHtml(line.nodes)}</div>`;
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Full HTML document
// ---------------------------------------------------------------------------

export interface TranscriptOptions {
  narrativeLines: NarrativeLine[];
  width: number;
  campaignName: string;
  themeAsset: ThemeAsset;
  separatorColor: string;
  playerColor: string;
  quoteColor: string;
}

export function buildTranscriptHtml(opts: TranscriptOptions): string {
  const {
    narrativeLines, width, campaignName,
    themeAsset, separatorColor, playerColor, quoteColor,
  } = opts;

  const processed = processNarrativeLines(narrativeLines, width, quoteColor);
  const separatorText = composeTurnSeparator(themeAsset, width);

  const bodyLines = processed
    .map((line) => lineToHtml(line, { separatorText, separatorColor, playerColor }))
    .filter(Boolean)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(campaignName)} — Transcript</title>
<style>
body {
  background: #000;
  color: #e0e0e0;
  font-family: 'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, Monaco, 'Courier New', monospace;
  max-width: ${width}ch;
  margin: 2em auto;
  padding: 0 1em;
  line-height: 1.4;
}
div {
  white-space: pre-wrap;
  word-wrap: break-word;
  min-height: 1.4em;
}
.spacer { min-height: 1.4em; }
.separator { text-align: center; opacity: 0.6; }
.system { color: #ffff55; }
.player .prompt { color: #55ff55; }
b { font-weight: bold; }
i { font-style: italic; }
u { text-decoration: underline; }
</style>
</head>
<body>
${bodyLines}
</body>
</html>`;
}
