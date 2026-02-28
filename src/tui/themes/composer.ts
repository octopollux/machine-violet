/**
 * Theme composition engine.
 * Assembles multi-line ASCII art borders from ThemeAsset components.
 */

import type { ThemeAsset, PlayerPaneFrame } from "./types.js";

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
 * Title text appears on row 0 only; other rows get spaces.
 */
export function composeTopFrame(
  asset: ThemeAsset,
  width: number,
  title?: string,
): ComposedFrame {
  const { corner_tl, corner_tr, edge_top, separator_left_top, separator_right_top } =
    asset.components;

  const titleText = title ?? "";
  const titleWidth = titleText.length > 0 ? titleText.length + 2 : 0; // +2 for padding spaces

  const rows: string[] = [];

  for (let r = 0; r < asset.height; r++) {
    const ctl = corner_tl.rows[r] ?? "";
    const ctr = corner_tr.rows[r] ?? "";
    const slt = titleWidth > 0 ? (separator_left_top.rows[r] ?? "") : "";
    const srt = titleWidth > 0 ? (separator_right_top.rows[r] ?? "") : "";
    const edge = edge_top.rows[r] ?? "";

    const fixedWidth = ctl.length + ctr.length + slt.length + srt.length;
    const centerWidth = titleWidth > 0 ? titleWidth : 0;
    const fillWidth = width - fixedWidth - centerWidth;

    if (fillWidth < 0) {
      // Degenerate: width too narrow, just tile everything
      rows.push(tileToWidth(edge, width));
      continue;
    }

    const leftFill = Math.floor(fillWidth / 2);
    const rightFill = fillWidth - leftFill;

    const centerPart =
      r === 0 && titleText.length > 0
        ? ` ${titleText} `
        : titleWidth > 0
          ? " ".repeat(titleWidth)
          : "";

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
 * Compose the bottom frame (Conversation Pane bottom border).
 * Same structure as top but uses corner_bl/br, edge_bottom, separator_left/right_bottom.
 * Turn indicator text appears on the last row.
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
    const slb = turnWidth > 0 ? (separator_left_bottom.rows[r] ?? "") : "";
    const srb = turnWidth > 0 ? (separator_right_bottom.rows[r] ?? "") : "";
    const edge = edge_bottom.rows[r] ?? "";

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
 * position "top" uses edge_top + corner_tl/tr; "bottom" uses edge_bottom + corner_bl/br.
 */
export function composeSimpleBorder(
  frame: PlayerPaneFrame,
  width: number,
  position: "top" | "bottom",
): ComposedFrame {
  const cornerL = position === "top"
    ? (frame.components.corner_tl.rows[0]?.[0] ?? "┌")
    : (frame.components.corner_bl.rows[0]?.[0] ?? "└");
  const cornerR = position === "top"
    ? (frame.components.corner_tr.rows[0]?.slice(-1) ?? "┐")
    : (frame.components.corner_br.rows[0]?.slice(-1) ?? "┘");

  const edge =
    position === "top"
      ? frame.components.edge_top.rows[0]
      : frame.components.edge_bottom.rows[0];

  const fillWidth = width - 2; // corners take 1 char each
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
