import type { NarrativeLine } from "../types/tui.js";

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
    if (line.startsWith("> ")) {
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
