import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";

/**
 * Append a streaming text delta to a NarrativeLine array.
 * Handles newline splitting and blank-line separator preservation.
 *
 * Returns a new array (immutable — safe for raw useState and the
 * batching hook alike).  The batching hook applies updaters eagerly
 * against a decoupled working copy, so intermediate copies don't
 * reach React state and the per-token cost is just a shallow copy.
 */
/**
 * `kind` is narrowed to the text-streamable kinds: image lines never
 * arrive via delta accumulation — they're pushed whole when the engine
 * emits a `display_image` TUI command (see event-handler.ts) and carry
 * their own `intent` field that the streaming path has no way to
 * supply.
 */
type StreamableKind = Exclude<NarrativeLine["kind"], "image">;

export function appendDelta(
  prev: NarrativeLine[],
  delta: string,
  kind: StreamableKind,
): NarrativeLine[] {
  const lines = [...prev];

  // If the last line is a pending spacer (from a trailing \n in a previous
  // chunk) and the new delta starts with \n, this confirms \n\n: promote
  // the spacer to a real blank DM line so it acts as a paragraph boundary.
  if (lines.length > 0 && lines[lines.length - 1].kind === "spacer" && delta.startsWith("\n")) {
    lines[lines.length - 1] = { kind, text: "" };
  }

  if (lines.length === 0) {
    lines.push({ kind, text: delta });
  } else {
    const last = lines[lines.length - 1];
    if (last.kind !== kind || (last.text === "" && delta !== "")) {
      lines.push({ kind, text: delta });
    } else {
      // last.kind === kind here by the discriminant check above — safe to
      // use the function's narrowed kind instead of widening through
      // last.kind (which the type system can't narrow past the equality).
      lines[lines.length - 1] = { kind, text: last.text + delta };
    }
  }

  // Split on newlines in last element. The last line was either pushed
  // or merged above using `kind`, so lastLine.kind === kind. Use `kind`
  // directly so the discriminated union sees a StreamableKind without
  // needing the original lastLine.kind narrowed past the union.
  const lastIdx = lines.length - 1;
  const lastLine = lines[lastIdx];
  if (lastLine.text.includes("\n")) {
    const parts = lastLine.text.split("\n");
    lines[lastIdx] = { kind, text: parts[0] };
    for (let i = 1; i < parts.length; i++) {
      // Double-space: insert a visual spacer between consecutive non-empty parts
      // so every LLM newline gets visual paragraph separation.
      // Existing \n\n (which produces an empty part) stays as one blank DM line.
      // Spacers are invisible to the healing pipeline — formatting tags persist
      // across them, unlike real blank DM lines which act as paragraph boundaries.
      if (parts[i - 1] !== "" && parts[i] !== "") {
        lines.push({ kind: "spacer", text: "" });
      }
      // Trailing empty part from a \n at end of chunk: use spacer so it
      // doesn't act as a false paragraph boundary. If the next delta
      // starts with \n (confirming \n\n), the promotion check above
      // will convert it to a real blank DM line.
      if (parts[i] === "" && i === parts.length - 1) {
        lines.push({ kind: "spacer", text: "" });
      } else {
        lines.push({ kind, text: parts[i] });
      }
    }
  }

  return lines;
}
