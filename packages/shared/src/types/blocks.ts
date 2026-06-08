/**
 * Block layer for the DM narrative pipeline.
 *
 * The narrative pipeline is two-level: an INLINE level (`FormattingNode` in
 * `tui.ts` — text + bold/italic/color/code/linebreak/… spans) and this BLOCK
 * level. `NarrativeLine[]` (from the streaming `appendDelta`) is normalized,
 * healed, and parsed into `Block[]`, then a width-correct layout engine turns
 * each block into one-or-more physical `ProcessedLine` rows.
 *
 * This module is intentionally React-free (only types + the `FormattingNode`
 * inline AST) so it can be imported by both Ink and HTML renderers and by the
 * engine's display-log round-trip without pulling in ink/React.
 */
import type { FormattingNode, ImageIntent } from "./tui.js";

/** One inline run (a flat `FormattingNode[]`), e.g. one row of an aligned block. */
export interface InlineRun {
  nodes: FormattingNode[];
}

/** One item of a list block. */
export interface ListItem {
  /** The item's own inline content (may itself wrap across rows at layout). */
  inline: FormattingNode[];
  /** Nesting depth (0 = top level). Drives marker glyph + indent. */
  depth: number;
  /** 1-based ordinal for ordered lists; absent for unordered. */
  ordinal?: number;
  /** Nested sub-items (for nested lists). */
  children?: ListItem[];
}

/**
 * A narrative block. Blockify produces these from healed/parsed narrative
 * lines; layout consumes them into `ProcessedLine[]`.
 */
export type Block =
  // A flowing prose paragraph. `inline` may contain `linebreak` nodes (hard
  // breaks) which layout honors without resetting formatting.
  | { type: "paragraph"; inline: FormattingNode[] }
  // A centered/right-aligned block. `rows` are the `<br>`-separated lines; each
  // wraps and pads to the target width independently (so a multi-line sign is N
  // aligned rows, not one overflowing row).
  | { type: "aligned"; align: "center" | "right"; rows: InlineRun[] }
  // An ordered/unordered list (possibly nested via `items[].children`).
  | { type: "list"; ordered: boolean; items: ListItem[] }
  // A markdown blockquote (`> …`) — distinct from inline dialogue-quote tinting.
  | { type: "quote"; inline: FormattingNode[] }
  // A themed horizontal divider (from `---`/`***`/`___`).
  | { type: "separator" }
  // A visual blank row that is INVISIBLE to healing (a single `\n` spacer).
  | { type: "spacer" }
  // A real paragraph-boundary blank (a `\n\n`) — resets heal + quote state.
  | { type: "blank" }
  // An inline image; `path` is the absolute PNG path the renderer loads.
  | { type: "image"; path: string; intent: ImageIntent }
  // A non-DM line carried through verbatim (player / system / dev).
  | { type: "raw"; kind: "player" | "system" | "dev"; text: string };
