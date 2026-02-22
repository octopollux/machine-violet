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

export type ViewportTier =
  | "full"
  | "narrow"
  | "short"
  | "compact"
  | "minimal";

export interface ViewportDimensions {
  columns: number;
  rows: number;
}

/** DM text formatting tag types */
export type FormattingTag =
  | { type: "bold"; content: FormattingNode[] }
  | { type: "italic"; content: FormattingNode[] }
  | { type: "underline"; content: FormattingNode[] }
  | { type: "center"; content: FormattingNode[] }
  | { type: "right"; content: FormattingNode[] }
  | { type: "color"; color: string; content: FormattingNode[] };

export type FormattingNode = string | FormattingTag;

/** Typed narrative line — only "dm" lines enter the formatting/heal/quote pipeline. */
export type NarrativeLine =
  | { kind: "dm"; text: string }
  | { kind: "player"; text: string }
  | { kind: "dev"; text: string }
  | { kind: "system"; text: string };

/** A fully processed line ready for rendering — nodes are pre-parsed, healed, wrapped, and quote-highlighted. */
export interface ProcessedLine {
  kind: NarrativeLine["kind"];
  nodes: FormattingNode[];
  alignment?: "center" | "right";
}

export interface ActivityIndicator {
  label: string;
  glyph: string;
}

export type ActiveModal =
  | { kind: "choice"; prompt: string; choices: string[] }
  | { kind: "dice"; expression: string; rolls: number[]; kept?: number[]; total: number; reason?: string }
  | { kind: "character_sheet"; content: string }
  | { kind: "recap"; lines: string[] }
  | null;
