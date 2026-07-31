/**
 * Build an HTML transcript from the live narrative lines.
 *
 * Renders FormattingNode trees into inline-styled HTML that preserves the
 * exporting terminal's column width on roomy viewports and reflows when space
 * is constrained. The HTML is self-contained (inlined CSS, no external
 * dependencies) and opens cleanly in any browser.
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
  if (tag.type === "linebreak") return "<br>";
  const inner = tag.content.map(nodeToHtml).join("");
  switch (tag.type) {
    case "bold":
      return `<b>${inner}</b>`;
    case "italic":
      return `<i>${inner}</i>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "code":
      return `<code>${inner}</code>`;
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
    case "quote":
      // Block tags handled at line level; if nested, just render inline
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
    case "metadata":
      return ""; // preserved separately in the invisible JSON metadata block

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
      return `<div class="image" style="text-align:center;margin:1em 0"><img src="data:${bytes.mimeType};base64,${bytes.base64}" alt="" class="zoomable" role="button" tabindex="0" aria-label="View image full screen" style="max-width:100%;height:auto;cursor:zoom-in"/></div>`;
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

    case "list": {
      // Each ProcessedLine is one physical row. The first row carries the marker
      // and a hanging indent (negative text-indent); continuation rows just pad.
      const indent = line.listIndent ?? 0;
      if (line.listMarker !== undefined) {
        return `<div class="list-item" style="padding-left:${indent}ch;text-indent:-${indent}ch">${esc(line.listMarker)} ${nodesToHtml(line.nodes)}</div>`;
      }
      return `<div class="list-item" style="padding-left:${indent}ch">${nodesToHtml(line.nodes)}</div>`;
    }

    case "dm": {
      if (isEmpty) return `<div class="dm">&nbsp;</div>`;
      // Blockquote row: a bordered, indented passage.
      const sole = line.nodes.length === 1 && typeof line.nodes[0] !== "string" ? line.nodes[0] : undefined;
      if (sole && sole.type === "quote") {
        return `<blockquote class="dm-quote">${nodesToHtml(sole.content)}</blockquote>`;
      }
      if (line.alignment) {
        const align = line.alignment === "center" ? "center" : "right";
        const inner =
          line.nodes.length === 1 && typeof line.nodes[0] !== "string" && "content" in line.nodes[0]
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

  // Width 0 keeps the formatting/healing pipeline but disables terminal-row
  // wrapping. The browser can then reflow each semantic line when its viewport
  // is narrower than the exporting terminal, while `max-width` below preserves
  // the original terminal-width column on roomy screens.
  const processed = processNarrativeLines(narrativeLines, 0, quoteColor);
  // Keep composeTurnSeparator's terminal-width truncation, but strip the space
  // padding it adds for physical-row centering. HTML centers the motif with CSS,
  // so padding would only create overflow in narrow viewports.
  const separatorText = composeTurnSeparator(themeAsset, width).trim();

  const bodyLines = processed
    .map((line) => lineToHtml(line, { separatorText, separatorColor, playerColor, imageBytes }))
    .filter(Boolean)
    .join("\n");

  let exportedEntryIndex = 0;
  const checkpoints: {
    afterEntry: number;
    state: Extract<
      Extract<NarrativeLine, { kind: "metadata" }>["event"],
      { type: "state_checkpoint" }
    >["state"];
  }[] = [];
  const choices = new Map<string, {
    id: string;
    source: "present_choices" | "suggestion_generator";
    presentedAfterEntry: number;
    prompt: string;
    options: { index: number; text: string; description?: string }[];
    resolution: null | {
      kind: "option" | "custom";
      playerId: string;
      contributionText: string;
      resolvedAfterEntry: number;
      optionIndex?: number;
      optionText?: string;
    };
  }>();
  for (const line of narrativeLines) {
    if (line.kind === "metadata") {
      switch (line.event.type) {
        case "state_checkpoint":
          checkpoints.push({ afterEntry: exportedEntryIndex, state: line.event.state });
          break;
        case "choices_presented": {
          const { presentation } = line.event;
          choices.set(presentation.id, {
            id: presentation.id,
            source: presentation.source,
            presentedAfterEntry: exportedEntryIndex,
            prompt: presentation.prompt,
            options: presentation.choices.map((text, index) => ({
              index,
              text,
              ...(presentation.descriptions?.[index] !== undefined
                ? { description: presentation.descriptions[index] }
                : {}),
            })),
            resolution: null,
          });
          break;
        }
        case "choice_resolved": {
          const { resolution } = line.event;
          const choice = choices.get(resolution.presentationId);
          if (!choice) break;
          choice.resolution = {
            kind: resolution.kind,
            playerId: resolution.playerId,
            contributionText: resolution.contributionText,
            resolvedAfterEntry: exportedEntryIndex,
            ...(resolution.kind === "option"
              ? {
                  optionIndex: resolution.optionIndex,
                  optionText: choice.options[resolution.optionIndex]?.text,
                }
              : {}),
          };
          break;
        }
      }
    } else if (line.kind !== "dev") {
      exportedEntryIndex += 1;
    }
  }
  // Escape '<' so formatted choices/modelines cannot terminate the script element.
  const metadataJson = JSON.stringify({
    format: "machine-violet-transcript-metadata",
    version: 1,
    checkpoints,
    choices: [...choices.values()],
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(campaignName)} — Transcript</title>
<style>
html {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
html:hover {
  scrollbar-color: ${esc(separatorColor)} transparent;
}
::-webkit-scrollbar {
  width: 9px;
  height: 9px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 5px;
}
html:hover::-webkit-scrollbar-thumb {
  background: ${esc(separatorColor)};
}
body {
  background: #000;
  color: #e0e0e0;
  font-family: 'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, Monaco, 'Courier New', monospace;
  max-width: ${width}ch;
  margin: 2em auto;
  padding: 0 clamp(2px, 2vw, 1em);
  line-height: 1.4;
}
div {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-height: 1.4em;
}
.spacer { min-height: 1.4em; }
.separator { text-align: center; opacity: 0.6; margin: 1.4em 0; }
.system { color: #ffff55; }
.player .prompt { color: inherit; }
b { font-weight: bold; }
i { font-style: italic; }
u { text-decoration: underline; }
.dm-quote {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-left: 2px solid #666;
  margin: 0;
  padding-left: 1ch;
  opacity: 0.9;
  font-style: italic;
  min-height: 1.4em;
}
.list-item { white-space: pre-wrap; overflow-wrap: anywhere; }
/* Image shadowbox: clicking a narrative image fills the viewport on black. */
#shadowbox {
  display: none;
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 1000;
  cursor: zoom-out;
  align-items: center;
  justify-content: center;
}
#shadowbox.open { display: flex; }
#shadowbox img {
  max-width: 100vw;
  max-height: 100vh;
  width: auto;
  height: auto;
  object-fit: contain;
  cursor: default;
}
.zoomable:focus { outline: 2px solid #888; outline-offset: 2px; }
</style>
</head>
<body>
${bodyLines}
<script id="machine-violet-transcript-metadata" type="application/json">${metadataJson}</script>
<div id="shadowbox"><img alt=""></div>
<script>
(function () {
  var box = document.getElementById('shadowbox');
  var boxImg = box.querySelector('img');
  function open(src) { boxImg.src = src; box.classList.add('open'); }
  function close() { box.classList.remove('open'); boxImg.removeAttribute('src'); }
  // Open on click of any narrative image.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('zoomable')) open(t.getAttribute('src'));
  });
  // Click the black backdrop closes; clicks/right-clicks ON the image are
  // left to the browser (save image, open in new tab, etc.).
  box.addEventListener('click', function (e) {
    if (e.target !== boxImg) close();
  });
  // Keyboard: Esc closes the shadowbox; Enter/Space opens it when a zoomable
  // image is focused (the images carry tabindex + role="button").
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && box.classList.contains('open')) { close(); return; }
    var t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('zoomable')) {
      e.preventDefault();
      open(t.getAttribute('src'));
    }
  });
})();
</script>
</body>
</html>`;
}
