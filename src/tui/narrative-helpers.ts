import type { NarrativeLine } from "../types/tui.js";

/**
 * Append a streaming text delta to a NarrativeLine array.
 * Handles newline splitting and blank-line separator preservation.
 */
export function appendDelta(
  prev: NarrativeLine[],
  delta: string,
  kind: NarrativeLine["kind"],
): NarrativeLine[] {
  const lines = [...prev];

  if (lines.length === 0) {
    lines.push({ kind, text: delta });
  } else {
    const last = lines[lines.length - 1];
    if (last.kind !== kind || (last.text === "" && delta !== "")) {
      lines.push({ kind, text: delta });
    } else {
      lines[lines.length - 1] = { kind: last.kind, text: last.text + delta };
    }
  }

  // Split on newlines in last element
  const lastIdx = lines.length - 1;
  const lastLine = lines[lastIdx];
  if (lastLine.text.includes("\n")) {
    const parts = lastLine.text.split("\n");
    lines[lastIdx] = { kind: lastLine.kind, text: parts[0] };
    for (let i = 1; i < parts.length; i++) {
      // Double-space: insert a blank line between consecutive non-empty parts
      // so every LLM newline gets visual paragraph separation.
      // Existing \n\n (which produces an empty part) stays as one blank line.
      if (parts[i - 1] !== "" && parts[i] !== "") {
        lines.push({ kind, text: "" });
      }
      lines.push({ kind, text: parts[i] });
    }
  }

  return lines;
}
