/**
 * HTML-ready colorized rows for the preview canvas.
 *
 * Mirrors ThemedFrame.tsx but produces arrays of { text, color } segments
 * instead of Ink <Text> nodes — ready to map to <span style={{color}}>.
 */

import type { ResolvedTheme } from "@engine-src/tui/themes/types.js";
import {
  composeTopFrame,
  composeBottomFrame,
  composeSimpleBorder,
  composeSideColumn,
  composeTurnSeparator,
  playerPaneSideColumn,
} from "@engine-src/tui/themes/composer.js";
import {
  colorizeSegments,
  mirrorT,
  applyGradient,
  hexToOklch,
  type GradientPreset,
} from "@engine-src/tui/color/index.js";
import { themeColor } from "@engine-src/tui/themes/color-resolve.js";

export interface Segment {
  text: string;
  color: string | undefined;
}

export type SegmentRow = Segment[];

function pushSegment(row: SegmentRow, text: string, color: string | undefined): void {
  if (text.length === 0) return;
  const last = row[row.length - 1];
  if (last && last.color === color) {
    last.text += text;
  } else {
    row.push({ text, color });
  }
}

function gradientSegments(
  row: string,
  baseHex: string | undefined,
  gradient: GradientPreset | undefined,
  offset: number,
  totalLength: number,
): SegmentRow {
  if (!gradient || !baseHex) return [{ text: row, color: baseHex }];
  const baseOklch = hexToOklch(baseHex);
  const segs = colorizeSegments(row, gradient, baseOklch, offset, totalLength);
  return segs.map((s) => ({ text: s.text, color: s.color }));
}

/**
 * Compose a horizontal (top or bottom) border row with optional center text.
 * When a center text is present and has a distinct color, splits the row so
 * the title renders in titleColor while the sides flow with the gradient.
 */
function composeBorderRows(
  rows: string[],
  borderColor: string | undefined,
  titleColor: string | undefined,
  gradient: GradientPreset | undefined,
  centerText: string | undefined,
): SegmentRow[] {
  return rows.map((row) => {
    const segments: SegmentRow = [];
    if (centerText && titleColor && titleColor !== borderColor) {
      const needle = ` ${centerText} `;
      const idx = row.indexOf(needle);
      if (idx >= 0) {
        const before = row.slice(0, idx);
        const after = row.slice(idx + needle.length);
        for (const s of gradientSegments(before, borderColor, gradient, 0, row.length)) {
          pushSegment(segments, s.text, s.color);
        }
        pushSegment(segments, needle, titleColor);
        for (const s of gradientSegments(after, borderColor, gradient, idx + needle.length, row.length)) {
          pushSegment(segments, s.text, s.color);
        }
        return segments;
      }
    }
    for (const s of gradientSegments(row, borderColor, gradient, 0, row.length)) {
      pushSegment(segments, s.text, s.color);
    }
    return segments;
  });
}

export interface FrameRenderOptions {
  width: number;
  height: number;
  title?: string;
  turnIndicator?: string;
  contentRows?: string[];
  /** Centered turn separator placed on this row of the content area (0-based). */
  turnSeparatorRow?: number;
}

export interface FrameRender {
  rows: SegmentRow[];
}

/**
 * Build the full rendered grid for a Conversation Pane.
 * Rows are returned top-to-bottom, each with its own colorized segments.
 *
 * Total height = 2 * asset.height + contentHeight.
 */
export function renderConversationFrame(theme: ResolvedTheme, opts: FrameRenderOptions): FrameRender {
  const { width, height, title, turnIndicator, contentRows, turnSeparatorRow } = opts;
  const borderHeight = theme.asset.height;
  const contentHeight = Math.max(0, height - 2 * borderHeight);

  const borderColor = themeColor(theme, "border");
  const titleColor = themeColor(theme, "title");
  const turnColor = themeColor(theme, "turnIndicator");
  const sideHex = themeColor(theme, "sideFrame");
  const separatorColor = themeColor(theme, "separator");

  const top = composeTopFrame(theme.asset, width, title);
  const bottom = composeBottomFrame(theme.asset, width, turnIndicator);

  const topRows = composeBorderRows(top.rows, borderColor, titleColor, theme.gradient, title);
  const bottomRows = composeBorderRows(bottom.rows, borderColor, turnColor, theme.gradient, turnIndicator);

  // Side columns span only the content rows
  const leftCol = composeSideColumn(theme.asset, "left", contentHeight);
  const rightCol = composeSideColumn(theme.asset, "right", contentHeight);

  // Content rows: left-edge + content text + right-edge, padded to width.
  const innerWidth = Math.max(0, width - theme.asset.components.edge_left.width - theme.asset.components.edge_right.width);
  const contentBody: SegmentRow[] = [];
  for (let i = 0; i < contentHeight; i++) {
    const row: SegmentRow = [];
    const leftEdge = leftCol[i] ?? " ";
    const rightEdge = rightCol[i] ?? " ";

    let sideColor: string | undefined;
    if (theme.gradient && borderColor) {
      const t = mirrorT(i, contentHeight);
      sideColor = applyGradient(theme.gradient, hexToOklch(borderColor), t);
    } else {
      sideColor = sideHex;
    }

    pushSegment(row, leftEdge, sideColor);

    const bodyText =
      turnSeparatorRow === i
        ? composeTurnSeparator(theme.asset, innerWidth)
        : (contentRows?.[i] ?? "").padEnd(innerWidth).slice(0, innerWidth);

    if (turnSeparatorRow === i) {
      pushSegment(row, bodyText, separatorColor);
    } else {
      pushSegment(row, bodyText, undefined);
    }

    pushSegment(row, rightEdge, sideColor);
    contentBody.push(row);
  }

  return { rows: [...topRows, ...contentBody, ...bottomRows] };
}

export interface ModalRenderOptions {
  width: number;
  height: number;
  title?: string;
  footer?: string;
  contentRows?: string[];
}

/**
 * Build a compact modal preview. Uses the passed-in (already modal-derived) theme.
 * Caller is responsible for applying deriveModalTheme() before calling.
 */
export function renderModal(modalTheme: ResolvedTheme, opts: ModalRenderOptions): FrameRender {
  return renderConversationFrame(modalTheme, {
    width: opts.width,
    height: opts.height,
    title: opts.title,
    turnIndicator: opts.footer,
    contentRows: opts.contentRows,
  });
}

export interface PlayerPaneRenderOptions {
  width: number;
  height: number;
  contentRows?: string[];
}

/**
 * Build a Player Pane preview.
 * Uses the 1-row simple border + per-row side chars from the player-frame asset.
 */
export function renderPlayerPane(theme: ResolvedTheme, opts: PlayerPaneRenderOptions): FrameRender {
  const { width, height, contentRows } = opts;
  const borderColor = themeColor(theme, "border");

  const top = composeSimpleBorder(theme.playerPaneFrame, width, "top");
  const bottom = composeSimpleBorder(theme.playerPaneFrame, width, "bottom");

  const contentHeight = Math.max(0, height - top.height - bottom.height);
  const leftChars = playerPaneSideColumn(theme.playerPaneFrame, "left", contentHeight);
  const rightChars = playerPaneSideColumn(theme.playerPaneFrame, "right", contentHeight);

  const topRows: SegmentRow[] = top.rows.map((r) => [{ text: r, color: borderColor }]);
  const bottomRows: SegmentRow[] = bottom.rows.map((r) => [{ text: r, color: borderColor }]);

  const innerWidth = Math.max(0, width - 2);
  const body: SegmentRow[] = [];
  for (let i = 0; i < contentHeight; i++) {
    const left = leftChars[i] ?? " ";
    const right = rightChars[i] ?? " ";
    const content = (contentRows?.[i] ?? "").padEnd(innerWidth).slice(0, innerWidth);
    const row: SegmentRow = [];
    pushSegment(row, left, borderColor);
    pushSegment(row, content, undefined);
    pushSegment(row, right, borderColor);
    body.push(row);
  }

  return { rows: [...topRows, ...body, ...bottomRows] };
}
