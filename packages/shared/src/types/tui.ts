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
    };

export type FormattingNode = string | FormattingTag;

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
   * filesystem path the renderer hands to ink-picture (or the plain-text
   * fallback when the terminal has no graphics protocol). `intent` lets
   * the renderer choose framing (scene snapshot vs. player-requested vs.
   * character portrait), though current rendering treats all three the
   * same. Per spec, exactly one separator NarrativeLine precedes an
   * image line; failed image generations never produce this kind.
   */
  | {
      kind: "image";
      text: string;
      intent: "scene_snapshot" | "player_request" | "character_portrait";
      tag?: string;
    };

/** A fully processed line ready for rendering — nodes are pre-parsed, healed, wrapped, and quote-highlighted. */
export interface ProcessedLine {
  kind: NarrativeLine["kind"];
  nodes: FormattingNode[];
  alignment?: "center" | "right";
  /**
   * Carried through from the source `image` NarrativeLine so the renderer can
   * pick framing — notably, portrait-aspect character portraits are contained
   * (fit-to-height, narrow) rather than filling the wide scene footprint.
   */
  intent?: Extract<NarrativeLine, { kind: "image" }>["intent"];
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
  | { kind: "notes"; content: string }
  | { kind: "saving" }
  | null;
