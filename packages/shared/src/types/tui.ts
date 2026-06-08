export interface FrameStyleVariant {
  horizontal: string;
  vertical: string;
  corner_tl: string;
  corner_tr: string;
  corner_bl: string;
  corner_br: string;
  flourish: string; // %s = centered text
  color?: string;
}

export interface FrameStyle {
  name: string;
  genre_tags: string[];
  variants: {
    exploration: FrameStyleVariant;
    combat: FrameStyleVariant;
    ooc: FrameStyleVariant;
    levelup: FrameStyleVariant;
    dev: FrameStyleVariant;
  };
}

export type StyleVariant = "exploration" | "combat" | "ooc" | "levelup" | "dev";

export type ViewportTier = "full" | "standard";

export interface ViewportDimensions {
  columns: number;
  rows: number;
}

/** DM text formatting tag types */
export type FormattingTag =
  | { type: "bold"; content: FormattingNode[] }
  | { type: "italic"; content: FormattingNode[] }
  | { type: "underline"; content: FormattingNode[] }
  | { type: "subscript"; content: FormattingNode[] }
  | { type: "superscript"; content: FormattingNode[] }
  | { type: "center"; content: FormattingNode[] }
  | { type: "right"; content: FormattingNode[] }
  | { type: "color"; color: string; content: FormattingNode[] }
  // `target` is the slug of the linked entity, preserved through the render
  // pipeline so future navigation features (clicking/keyboard-selecting a
  // wikilink to jump to its sheet) have the destination available without
  // re-parsing the source text. Render-only — not authored by LLMs.
  //
  // `selected` and `broken` are applied by post-processing passes (see
  // wikilink-nav.ts) to drive Lynx-style keyboard navigation in the
  // compendium detail view: the cursored link renders inverse; links whose
  // slug doesn't resolve render red (Wikipedia-style) and are inert on Enter.
  | {
      type: "wikilink";
      target: string;
      content: FormattingNode[];
      selected?: boolean;
      broken?: boolean;
    }
  // Hard line break (from `<br>`). A contentless leaf — it carries no text and
  // zero display width. On the narrative path the layout engine splits aligned
  // rows on these (so a multi-line centered sign becomes N padded rows); it is
  // structural, NOT a heal-stack tag (a `<br>` never resets open formatting the
  // way a blank DM line does). Generic node-walkers treat it as empty.
  | { type: "linebreak" }
  // Inline monospace (from `<code>` / `` `backtick` ``). Behaves like the other
  // styling tags for wrapping/quoting; its content is not re-parsed for tags.
  | { type: "code"; content: FormattingNode[] };

export type FormattingNode = string | FormattingTag;

/** Framing intent carried by an inline image, chosen by the engine. */
export type ImageIntent = "scene_snapshot" | "player_request" | "character_portrait";

/** Typed narrative line — only "dm" lines enter the formatting/heal/quote pipeline. */
export type NarrativeLine =
  | { kind: "dm"; text: string; tag?: string }
  | { kind: "player"; text: string; tag?: string }
  | { kind: "dev"; text: string; tag?: string }
  | { kind: "system"; text: string; tag?: string }
  | { kind: "separator"; text: string; tag?: string }
  | { kind: "spacer"; text: string; tag?: string }
  /**
   * Inline-rendered image, pushed when the engine emits a `display_image`
   * TUI command after persisting a generated PNG. `text` is the absolute
   * filesystem path the inline-image renderer loads (rendered via the
   * terminal's graphics protocol, or nothing inline when it has none —
   * the full-res image still lives in the HTML transcript export). `intent` lets
   * the renderer choose framing (scene snapshot vs. player-requested vs.
   * character portrait), though current rendering treats all three the
   * same. Per spec, exactly one separator NarrativeLine precedes an
   * image line; failed image generations never produce this kind.
   */
  | {
      kind: "image";
      text: string;
      intent: ImageIntent;
      tag?: string;
    };

/**
 * A fully processed PHYSICAL line ready for rendering — nodes are pre-parsed,
 * healed, wrapped (by display width), and quote-highlighted. One ProcessedLine
 * is exactly one terminal row.
 */
export interface ProcessedLine {
  kind: NarrativeLine["kind"] | "list";
  nodes: FormattingNode[];
  alignment?: "center" | "right";
  /**
   * Full column width an aligned row pads/centers within. Set on aligned rows
   * so the Ink (`Box justifyContent`) and HTML (`text-align`) renderers agree on
   * the same field, and so a wrapped aligned block's rows each pad to `padWidth`.
   */
  padWidth?: number;
  /** First row of a list item: the resolved marker (`•`, `1.`, …). */
  listMarker?: string;
  /** Leading indent (columns) for a list row — hanging-indent continuation rows
   *  carry this without a `listMarker`. */
  listIndent?: number;
  /**
   * Carried through from the source `image` NarrativeLine so the renderer can
   * pick framing — notably, portrait-aspect character portraits are contained
   * (fit-to-height, narrow) rather than filling the wide scene footprint.
   */
  intent?: ImageIntent;
}

export interface ActivityIndicator {
  label: string;
  glyph: string;
}

export interface RetryOverlay {
  status: number;
  delaySec: number;
  /** Bumped on every retry event so the modal can reset its countdown
   *  even when a successive retry has identical status/delaySec. */
  attemptId: number;
}

export type ActiveModal =
  | { kind: "choice"; prompt: string; choices: string[]; descriptions?: string[] }
  | { kind: "character_sheet"; content: string }
  | { kind: "recap"; lines: string[] }
  | { kind: "compendium"; data: import("./compendium.js").Compendium }
  | { kind: "swatch" }
  | { kind: "rollback"; summary: string }
  // Roll Back Game flow (client-local): pick a savepoint, then confirm.
  | { kind: "rollback_picker"; savepoints: import("../protocol/rest.js").Savepoint[]; gitEnabled: boolean }
  | { kind: "rollback_confirm"; savepoint: import("../protocol/rest.js").Savepoint; discardCount: number }
  | { kind: "notes"; content: string }
  | { kind: "saving" }
  | null;
