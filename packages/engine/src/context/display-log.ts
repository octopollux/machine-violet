import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";

/**
 * Marker line emitted for `kind: "image"` NarrativeLines. The intent
 * (scene_snapshot / player_request / character_portrait) is encoded in
 * the marker so the roundtrip preserves it; the path that follows is
 * absolute (matches what NarrativeLine.text carries in-memory after a
 * display_image TUI command). Future work: make the path campaign-root-
 * relative so transcripts survive a campaign move; today's HTML export
 * has the same absolute-path limitation, so the two cohere.
 */
const IMAGE_INTENTS = new Set(["scene_snapshot", "player_request", "character_portrait"] as const);
const IMAGE_LINE_RE = /^\[image:(scene_snapshot|player_request|character_portrait)\] (.+)$/;

/**
 * Convert NarrativeLines to markdown for appending to display-log.md.
 * Dev lines are excluded — they're ephemeral debug info.
 */
export function narrativeLinesToMarkdown(lines: NarrativeLine[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    switch (line.kind) {
      case "dm":
        parts.push(line.text);
        break;
      case "player":
        parts.push(`> ${line.text}`);
        break;
      case "system":
        parts.push(`[system] ${line.text}`);
        break;
      case "separator":
        parts.push("---");
        break;
      case "image":
        parts.push(`[image:${line.intent}] ${line.text}`);
        break;
      case "spacer":
      case "dev":
        // Ephemeral — not logged
        break;
    }
  }
  return parts.join("\n") + "\n";
}

/**
 * Parse markdown lines from display-log.md back to NarrativeLines.
 */
export function markdownToNarrativeLines(lines: string[]): NarrativeLine[] {
  const result: NarrativeLine[] = [];
  for (const line of lines) {
    const imgMatch = IMAGE_LINE_RE.exec(line);
    if (imgMatch && IMAGE_INTENTS.has(imgMatch[1] as never)) {
      result.push({
        kind: "image",
        text: imgMatch[2],
        intent: imgMatch[1] as "scene_snapshot" | "player_request" | "character_portrait",
      });
    } else if (line.startsWith("> ")) {
      result.push({ kind: "player", text: line.slice(2) });
    } else if (line.startsWith("[system] ")) {
      result.push({ kind: "system", text: line.slice(9) });
    } else if (line === "---") {
      result.push({ kind: "separator", text: "---" });
    } else {
      result.push({ kind: "dm", text: line });
    }
  }
  return result;
}

/** Return the last `maxLines` lines from a string, trimming trailing blanks. */
export function tailLines(content: string, maxLines: number): string[] {
  const lines = content.split("\n");
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.slice(-maxLines);
}
