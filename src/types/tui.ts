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

export interface ActivityIndicator {
  label: string;
  glyph: string;
}
