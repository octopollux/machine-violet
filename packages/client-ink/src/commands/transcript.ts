/**
 * Build an HTML transcript from the live narrative lines.
 *
 * Renders FormattingNode trees into inline-styled HTML that visually
 * matches the TUI output. The HTML is self-contained (inlined CSS,
 * no external dependencies) and opens cleanly in any browser.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
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
    case "subscript":
      return `<sub>${inner}</sub>`;
    case "superscript":
      return `<sup>${inner}</sup>`;
    case "color":
      return `<span style="color:${esc(tag.color)}">${inner}</span>`;
    case "wikilink":
      // Wikilinks are render-only AST nodes from the character/compendium
      // colorizer. Transcript HTML doesn't link them yet; render inline.
      return inner;
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
  opts: {
    separatorText: string;
    separatorColor: string;
    playerColor: string;
    imageBytes?: Record<string, { mimeType: string; base64: string }>;
  },
): string {
  const isEmpty =
    line.nodes.length === 0 ||
    (line.nodes.length === 1 && line.nodes[0] === "");

  switch (line.kind) {
    case "spacer":
      return `<div class="spacer">&nbsp;</div>`;

    case "separator":
      return `<div class="separator" style="color:${esc(opts.separatorColor)}">${esc(opts.separatorText)}</div>`;

    case "image": {
      // Image lines carry the absolute filesystem path in nodes[0]. The
      // export caller pre-loads bytes (keyed by that path) and passes
      // them in opts.imageBytes so the exported HTML is self-contained —
      // a single .html file with base64 data: URIs, openable without
      // any sibling files. Missing bytes for a path mean the file was
      // unreadable at export time; we emit a small placeholder rather
      // than a broken <img>.
      const path = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      const bytes = path && opts.imageBytes ? opts.imageBytes[path] : undefined;
      if (!bytes) {
        return `<div class="image-missing" style="text-align:center;opacity:0.4;font-style:italic">[image unavailable]</div>`;
      }
      return `<div class="image" style="text-align:center;margin:1em 0"><img src="data:${bytes.mimeType};base64,${bytes.base64}" alt="" style="max-width:100%;height:auto"/></div>`;
    }

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
  /**
   * Pre-loaded image bytes keyed by the absolute path each image
   * NarrativeLine carries in `text`. Caller is responsible for the
   * disk reads (keeping buildTranscriptHtml synchronous + pure). Any
   * image line whose path isn't present in this map renders as a
   * small "[image unavailable]" placeholder — sometimes the file's
   * been moved or deleted by the time the export runs.
   */
  imageBytes?: Record<string, { mimeType: string; base64: string }>;
}

/**
 * Read every image-line PNG referenced by `narrativeLines` and return a
 * map keyed by the same absolute paths the lines carry in `text`. Hands
 * the result to {@link buildTranscriptHtml} via `opts.imageBytes` so the
 * generated HTML can inline them as `data:` URIs and be a single
 * shareable file.
 *
 * Unreadable files (moved, deleted, permission denied) are omitted from
 * the map silently — the HTML renderer emits an "[image unavailable]"
 * placeholder when an image line's path isn't in the map.
 */
export async function loadImageBytes(
  narrativeLines: NarrativeLine[],
): Promise<Record<string, { mimeType: string; base64: string }>> {
  const paths = new Set<string>();
  for (const line of narrativeLines) {
    if (line.kind === "image" && line.text) paths.add(line.text);
  }
  const result: Record<string, { mimeType: string; base64: string }> = {};
  await Promise.all([...paths].map(async (p) => {
    try {
      const buf = await readFile(p);
      result[p] = { mimeType: mimeFromExt(p), base64: buf.toString("base64") };
    } catch { /* skip unreadable */ }
  }));
  return result;
}

function mimeFromExt(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

export function buildTranscriptHtml(opts: TranscriptOptions): string {
  const {
    narrativeLines, width, campaignName,
    themeAsset, separatorColor, playerColor, quoteColor, imageBytes,
  } = opts;

  const processed = processNarrativeLines(narrativeLines, width, quoteColor);
  const separatorText = composeTurnSeparator(themeAsset, width);

  const bodyLines = processed
    .map((line) => lineToHtml(line, { separatorText, separatorColor, playerColor, imageBytes }))
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
.separator { text-align: center; opacity: 0.6; margin: 1.4em 0; }
.system { color: #ffff55; }
.player .prompt { color: inherit; }
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
