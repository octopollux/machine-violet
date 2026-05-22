/**
 * Theme composition engine.
 * Assembles multi-line ASCII art borders from ThemeAsset components.
 */

import type { ThemeAsset, ThemeComponent, PlayerPaneFrame } from "./types.js";
import { stringWidth, truncateToWidth } from "../frames/index.js";

/** A composed frame: an array of string rows ready for rendering. */
export interface ComposedFrame {
  rows: string[];
  height: number;
}

/**
 * Tile a repeating pattern string to a target width.
 * Repeats the pattern and truncates to fit exactly.
 */
export function tileToWidth(pattern: string, targetWidth: number): string {
  if (targetWidth <= 0) return "";
  if (pattern.length === 0) return " ".repeat(targetWidth);

  let result = "";
  while (result.length < targetWidth) {
    result += pattern;
  }
  return result.slice(0, targetWidth);
}

/**
 * Compose the top frame (Conversation Pane top border).
 * Each row: corner_tl[r] + tile(edge_top[r]) + sep_lt[r] + title_or_space + sep_rt[r] + tile(edge_top[r]) + corner_tr[r]
 *
 * `title` may be a single string (head only, on row 0) or an array of
 * strings (head on row 0, continuation chunks on rows 1, 2, …). When
 * there are more title lines than `asset.height`, the frame's height
 * grows to fit; extra rows reuse the last available row's corner / edge
 * components so the side edges stay continuous. The separator decoration
 * around the title slot still only appears on rows where the source
 * `separator_*_top` component defines content (typically row 0).
 *
 * The title slot is sized to the longest line + 2 padding spaces, so a
 * short continuation centered under a long head still fits cleanly.
 */
export function composeTopFrame(
  asset: ThemeAsset,
  width: number,
  title?: string | string[],
): ComposedFrame {
  const { corner_tl, corner_tr, edge_top, edge_left, edge_right, separator_left_top, separator_right_top } =
    asset.components;

  const titleLines = Array.isArray(title) ? title : title ? [title] : [];
  // All column math goes through `stringWidth` so wide Unicode (CJK / emoji)
  // doesn't lie about how many cells a title or border glyph occupies.
  const longestLen = titleLines.reduce((m, l) => Math.max(m, stringWidth(l)), 0);

  // Worst-case row overhead: row 0 carries the corners + separators (their
  // largest configuration, given separators are only painted when titleWidth>0).
  // Clamping titleWidth against this floor guarantees `fillWidth >= 0` on
  // every row, so the frame never falls through to the bare-edge fallback.
  const row0Fixed = stringWidth(corner_tl.rows[0] ?? "")
    + stringWidth(corner_tr.rows[0] ?? "")
    + (longestLen > 0 ? stringWidth(separator_left_top.rows[0] ?? "") : 0)
    + (longestLen > 0 ? stringWidth(separator_right_top.rows[0] ?? "") : 0);
  const maxTitleSlot = Math.max(0, width - row0Fixed);
  const titleWidth = longestLen > 0 ? Math.min(longestLen + 2, maxTitleSlot) : 0;
  // Available room inside the title slot for the line text (excluding the
  // 2 padding spaces). A line longer than this is hard-truncated with an
  // ellipsis to preserve the surrounding frame.
  const lineMaxWidth = Math.max(0, titleWidth - 2);

  const totalRows = Math.max(asset.height, titleLines.length);
  const rows: string[] = [];

  for (let r = 0; r < totalRows; r++) {
    // For rows inside the native asset.height, use the corner component's
    // row — multi-row themes (gothic, arcane) design row 1+ of the corner
    // to look like a side-frame char. Beyond that, switch to edge_left /
    // edge_right so single-row themes (clean) don't repeat their corners.
    const insideAsset = r < asset.height;
    const ctl = insideAsset
      ? (corner_tl.rows[r] ?? "")
      : (edge_left.rows[0] ?? "");
    const ctr = insideAsset
      ? (corner_tr.rows[r] ?? "")
      : (edge_right.rows[0] ?? "");
    const slt = titleWidth > 0 && insideAsset ? (separator_left_top.rows[r] ?? "") : "";
    const srt = titleWidth > 0 && insideAsset ? (separator_right_top.rows[r] ?? "") : "";
    // Extension rows have no edge_top equivalent — fill with spaces so the
    // title sits centered on a clean blank between the side edges.
    const edge = insideAsset ? (edge_top.rows[r] ?? "") : " ";

    const fixedWidth = stringWidth(ctl) + stringWidth(ctr) + stringWidth(slt) + stringWidth(srt);
    const centerWidth = titleWidth > 0 ? titleWidth : 0;
    const fillWidth = width - fixedWidth - centerWidth;

    if (fillWidth < 0) {
      // Safety net — titleWidth was clamped against row 0's worst case, so
      // we shouldn't land here in practice. Fall back to a bare edge tile
      // rather than emit a malformed row.
      rows.push(tileToWidth(edge, width));
      continue;
    }

    const leftFill = Math.floor(fillWidth / 2);
    const rightFill = fillWidth - leftFill;

    // Truncate any per-row line that would overflow the (possibly clamped)
    // slot, then center it inside the slot so a short continuation under
    // a long head aligns visually under it.
    const lineForRow = titleLines[r] ?? "";
    const fittedLine = stringWidth(lineForRow) > lineMaxWidth
      ? truncateToWidth(lineForRow, lineMaxWidth)
      : lineForRow;
    let centerPart: string;
    if (titleWidth === 0) {
      centerPart = "";
    } else if (fittedLine.length === 0) {
      centerPart = " ".repeat(titleWidth);
    } else {
      const innerPad = titleWidth - 2 - stringWidth(fittedLine);
      const innerLeft = Math.floor(innerPad / 2);
      const innerRight = innerPad - innerLeft;
      centerPart = ` ${" ".repeat(innerLeft)}${fittedLine}${" ".repeat(innerRight)} `;
    }

    rows.push(
      ctl +
        tileToWidth(edge, leftFill) +
        slt +
        centerPart +
        srt +
        tileToWidth(edge, rightFill) +
        ctr,
    );
  }

  return { rows, height: rows.length };
}

/**
 * Bottom-align a component's row access: short components align to the last row.
 * For a 1-row edge in a height-2 frame, row 0 → "" and row 1 → the content.
 */
function bottomRow(comp: ThemeComponent, r: number, frameHeight: number): string {
  const idx = r - (frameHeight - comp.height);
  return idx >= 0 ? (comp.rows[idx] ?? "") : "";
}

/**
 * Compose the bottom frame (Conversation Pane bottom border).
 * Same structure as top but uses corner_bl/br, edge_bottom, separator_left/right_bottom.
 * Turn indicator text appears on the last row.
 * Non-corner components are bottom-aligned so short edges sit on the closing row.
 */
export function composeBottomFrame(
  asset: ThemeAsset,
  width: number,
  turnIndicator?: string,
): ComposedFrame {
  const {
    corner_bl,
    corner_br,
    edge_bottom,
    separator_left_bottom,
    separator_right_bottom,
  } = asset.components;

  const turnText = turnIndicator ?? "";
  const turnWidth = turnText.length > 0 ? turnText.length + 2 : 0;

  const rows: string[] = [];

  for (let r = 0; r < asset.height; r++) {
    const cbl = corner_bl.rows[r] ?? "";
    const cbr = corner_br.rows[r] ?? "";
    const slb = turnWidth > 0 ? bottomRow(separator_left_bottom, r, asset.height) : "";
    const srb = turnWidth > 0 ? bottomRow(separator_right_bottom, r, asset.height) : "";
    const edge = bottomRow(edge_bottom, r, asset.height);

    const fixedWidth = cbl.length + cbr.length + slb.length + srb.length;
    const centerWidth = turnWidth > 0 ? turnWidth : 0;
    const fillWidth = width - fixedWidth - centerWidth;

    if (fillWidth < 0) {
      rows.push(tileToWidth(edge, width));
      continue;
    }

    const leftFill = Math.floor(fillWidth / 2);
    const rightFill = fillWidth - leftFill;

    // Turn indicator on the last row
    const isLastRow = r === asset.height - 1;
    const centerPart =
      isLastRow && turnText.length > 0
        ? ` ${turnText} `
        : turnWidth > 0
          ? " ".repeat(turnWidth)
          : "";

    rows.push(
      cbl +
        tileToWidth(edge, leftFill) +
        slb +
        centerPart +
        srb +
        tileToWidth(edge, rightFill) +
        cbr,
    );
  }

  return { rows, height: rows.length };
}

/**
 * Compose a simple 1-row border for the Player Pane.
 * Uses the dedicated PlayerPaneFrame components.
 * position "top" uses edge_top + corner_tl/tr row 0;
 * "bottom" uses edge_bottom + corner_bl/br last row.
 * Multi-char corner rows are supported — fillWidth adjusts accordingly.
 */
export function composeSimpleBorder(
  frame: PlayerPaneFrame,
  width: number,
  position: "top" | "bottom",
): ComposedFrame {
  let cornerL: string;
  let cornerR: string;
  if (position === "top") {
    cornerL = frame.components.corner_tl.rows[0] ?? "┌";
    cornerR = frame.components.corner_tr.rows[0] ?? "┐";
  } else {
    const blLast = frame.components.corner_bl.height - 1;
    const brLast = frame.components.corner_br.height - 1;
    cornerL = frame.components.corner_bl.rows[blLast] ?? "└";
    cornerR = frame.components.corner_br.rows[brLast] ?? "┘";
  }

  const edge =
    position === "top"
      ? frame.components.edge_top.rows[0]
      : frame.components.edge_bottom.rows[0];

  const fillWidth = width - cornerL.length - cornerR.length;
  if (fillWidth <= 0) {
    return { rows: [tileToWidth(edge ?? "─", width)], height: 1 };
  }

  const row = cornerL + tileToWidth(edge ?? "─", fillWidth) + cornerR;
  return { rows: [row], height: 1 };
}

/**
 * Get the single-character side edge for the Player Pane.
 * Uses the first character of edge_left / last character of edge_right from the PlayerPaneFrame.
 */
export function playerPaneSideChar(frame: PlayerPaneFrame, side: "left" | "right"): string {
  if (side === "left") {
    return frame.components.edge_left.rows[0]?.[0] ?? "│";
  }
  const rightRow = frame.components.edge_right.rows[0] ?? "│";
  return rightRow.slice(-1) || "│";
}

/**
 * Build a side column for the Player Pane, composited from multi-row corners + edge.
 * Returns one character per content row:
 *  - Rows 0..topCorner.height-2:  chars from top corner rows 1..N-1
 *  - Middle rows:                  edge char (from edge_left / edge_right)
 *  - Last bottomCorner.height-1 rows: chars from bottom corner rows 0..N-2
 * For the left side, the first character of each row is used.
 * For the right side, the last character of each row is used.
 */
export function playerPaneSideColumn(
  frame: PlayerPaneFrame,
  side: "left" | "right",
  contentHeight: number,
): string[] {
  const topCorner = side === "left" ? frame.components.corner_tl : frame.components.corner_tr;
  const bottomCorner = side === "left" ? frame.components.corner_bl : frame.components.corner_br;
  const edgeComp = side === "left" ? frame.components.edge_left : frame.components.edge_right;

  const pickChar = (row: string | undefined): string => {
    if (!row) return " ";
    return side === "left" ? (row[0] ?? " ") : (row.slice(-1) || " ");
  };

  const edgeChar = pickChar(edgeComp.rows[0]);
  const topRows = topCorner.height - 1; // corner rows 1..N-1
  const bottomRows = bottomCorner.height - 1; // corner rows 0..N-2

  const result: string[] = [];
  for (let i = 0; i < contentHeight; i++) {
    if (i < topRows) {
      result.push(pickChar(topCorner.rows[i + 1]));
    } else if (i >= contentHeight - bottomRows) {
      const bottomIdx = i - (contentHeight - bottomRows);
      result.push(pickChar(bottomCorner.rows[bottomIdx]));
    } else {
      result.push(edgeChar);
    }
  }

  return result;
}

/**
 * Compose a vertical side column for the given height.
 * Tiles the edge_left or edge_right pattern vertically.
 */
export function composeSideColumn(
  asset: ThemeAsset,
  side: "left" | "right",
  height: number,
): string[] {
  const comp = side === "left" ? asset.components.edge_left : asset.components.edge_right;

  const result: string[] = [];
  for (let i = 0; i < height; i++) {
    const r = i % comp.height;
    result.push(comp.rows[r] ?? " ");
  }
  return result;
}

/**
 * Compose the turn separator for narrative content.
 * Centers the turn_separator pattern within the given width.
 */
export function composeTurnSeparator(asset: ThemeAsset, width: number): string {
  const sep = asset.components.turn_separator;
  const sepText = sep.rows[0] ?? "──";
  const sepWidth = sepText.length;

  if (sepWidth >= width) return sepText.slice(0, width);

  const leftPad = Math.floor((width - sepWidth) / 2);
  const rightPad = width - sepWidth - leftPad;
  return " ".repeat(leftPad) + sepText + " ".repeat(rightPad);
}
