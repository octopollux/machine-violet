import type { NarrativeLine } from "../types/tui.js";

/**
 * Append a streaming text delta to a NarrativeLine array.
 * Handles newline splitting and blank-line separator preservation.
 *
 * **Mutates `prev` in place** for performance — the batching hook
 * (`useBatchedNarrativeLines`) owns the mutable working copy and
 * snapshots it at flush time.  This avoids O(n) array copies on
 * every streaming token, dramatically reducing GC pressure.
 *
 * Returns `prev` (same reference) for API compatibility with
 * React's functional-update signature `(prev) => next`.
 */
export function appendDelta(
  prev: NarrativeLine[],
  delta: string,
  kind: NarrativeLine["kind"],
): NarrativeLine[] {
  if (prev.length === 0) {
    prev.push({ kind, text: delta });
  } else {
    const last = prev[prev.length - 1];
    if (last.kind !== kind || (last.text === "" && delta !== "")) {
      prev.push({ kind, text: delta });
    } else {
      prev[prev.length - 1] = { kind: last.kind, text: last.text + delta };
    }
  }

  // Split on newlines in last element
  const lastIdx = prev.length - 1;
  const lastLine = prev[lastIdx];
  if (lastLine.text.includes("\n")) {
    const parts = lastLine.text.split("\n");
    prev[lastIdx] = { kind: lastLine.kind, text: parts[0] };
    for (let i = 1; i < parts.length; i++) {
      // Double-space: insert a blank line between consecutive non-empty parts
      // so every LLM newline gets visual paragraph separation.
      // Existing \n\n (which produces an empty part) stays as one blank line.
      if (parts[i - 1] !== "" && parts[i] !== "") {
        prev.push({ kind, text: "" });
      }
      prev.push({ kind, text: parts[i] });
    }
  }

  return prev;
}
