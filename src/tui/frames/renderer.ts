import React from "react";
import { Text } from "ink";
import type { FormattingNode, FrameStyleVariant } from "../../types/tui.js";
import { toPlainText, parseFormatting } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";

/** ASCII fallback for terminals that can't render Unicode box-drawing */
const ASCII_VARIANT: FrameStyleVariant = {
  horizontal: "-",
  vertical: "|",
  corner_tl: "+",
  corner_tr: "+",
  corner_bl: "+",
  corner_br: "+",
  flourish: "- %s -",
};

/**
 * Render a horizontal frame line (top or bottom border).
 * @param variant - The style variant to use
 * @param width - Total width in columns
 * @param position - "top" or "bottom" (selects corners)
 * @param centerText - Optional text to center in the line (for turn indicator, etc.)
 * @param ascii - Force ASCII fallback
 */
export function renderHorizontalFrame(
  variant: FrameStyleVariant,
  width: number,
  position: "top" | "bottom",
  centerText?: string,
  ascii = false,
): string {
  const v = ascii ? ASCII_VARIANT : variant;
  const left = position === "top" ? v.corner_tl : v.corner_bl;
  const right = position === "top" ? v.corner_tr : v.corner_br;

  if (width < 4) return v.horizontal.repeat(width);

  const innerWidth = width - 2; // minus corners

  if (centerText) {
    const flourished = v.flourish.replace("%s", centerText);
    const flourishLen = stringWidth(flourished);

    if (flourishLen >= innerWidth) {
      // Flourish too wide — just center the text
      const textLen = stringWidth(centerText);
      const padTotal = Math.max(0, innerWidth - textLen);
      const padLeft = Math.floor(padTotal / 2);
      const padRight = padTotal - padLeft;
      return left + v.horizontal.repeat(padLeft) + centerText + v.horizontal.repeat(padRight) + right;
    }

    const padTotal = innerWidth - flourishLen;
    const padLeft = Math.floor(padTotal / 2);
    const padRight = padTotal - padLeft;
    return left + v.horizontal.repeat(padLeft) + flourished + v.horizontal.repeat(padRight) + right;
  }

  return left + v.horizontal.repeat(innerWidth) + right;
}

/**
 * Like renderHorizontalFrame, but returns the border split into three parts
 * so the center text can be colored independently.
 */
export function renderHorizontalFrameParts(
  variant: FrameStyleVariant,
  width: number,
  position: "top" | "bottom",
  centerText: string,
  ascii = false,
): { left: string; center: string; right: string } {
  const v = ascii ? ASCII_VARIANT : variant;
  const leftCorner = position === "top" ? v.corner_tl : v.corner_bl;
  const rightCorner = position === "top" ? v.corner_tr : v.corner_br;

  if (width < 4) return { left: v.horizontal.repeat(width), center: "", right: "" };

  const innerWidth = width - 2; // minus corners

  const flourished = v.flourish.replace("%s", centerText);
  const flourishLen = stringWidth(flourished);

  if (flourishLen >= innerWidth) {
    // Flourish too wide — just center the text
    const textLen = stringWidth(centerText);
    const padTotal = Math.max(0, innerWidth - textLen);
    const padLeft = Math.floor(padTotal / 2);
    const padRight = padTotal - padLeft;
    return {
      left: leftCorner + v.horizontal.repeat(padLeft),
      center: centerText,
      right: v.horizontal.repeat(padRight) + rightCorner,
    };
  }

  const padTotal = innerWidth - flourishLen;
  const padLeft = Math.floor(padTotal / 2);
  const padRight = padTotal - padLeft;

  // Split the flourish template around the center text
  const flourishParts = v.flourish.split("%s");
  return {
    left: leftCorner + v.horizontal.repeat(padLeft) + flourishParts[0],
    center: centerText,
    right: flourishParts[1] + v.horizontal.repeat(padRight) + rightCorner,
  };
}

/**
 * Render a content line with left/right vertical borders.
 * @param variant - The style variant to use
 * @param content - The text content to display
 * @param width - Total width in columns
 * @param ascii - Force ASCII fallback
 */
export function renderContentLine(
  variant: FrameStyleVariant,
  content: string,
  width: number,
  ascii = false,
): string {
  const v = ascii ? ASCII_VARIANT : variant;

  if (width < 4) return content.slice(0, width);

  const innerWidth = width - 4; // 2 for borders + 2 for padding spaces
  const contentLen = stringWidth(content);
  const truncated = contentLen > innerWidth
    ? truncateToWidth(content, innerWidth)
    : content;
  const pad = Math.max(0, innerWidth - stringWidth(truncated));

  return `${v.vertical} ${truncated}${" ".repeat(pad)} ${v.vertical}`;
}

/**
 * Render a top frame with resource display.
 * Layout: first resource left, campaign name center, remaining resources right.
 */
export function renderTopFrame(
  variant: FrameStyleVariant,
  width: number,
  campaignName: string,
  resources: string[],
  ascii = false,
): string[] {
  const top = renderHorizontalFrame(variant, width, "top", undefined, ascii);
  const v = ascii ? ASCII_VARIANT : variant;

  const innerWidth = width - 4; // borders + padding
  if (innerWidth < 1) return [top];

  const leftResource = resources[0] ?? "";
  const rightResources = resources.slice(1).join("  ");

  // Build the content line
  const leftLen = stringWidth(leftResource);
  const rightLen = stringWidth(rightResources);
  const nameLen = stringWidth(campaignName);

  // If everything fits, center the name between left and right
  const totalContentLen = leftLen + nameLen + rightLen;
  if (totalContentLen + 4 <= innerWidth) {
    // Distribute space
    const spaceAvail = innerWidth - leftLen - nameLen - rightLen;
    const leftPad = Math.floor(spaceAvail / 2);
    const rightPad = spaceAvail - leftPad;
    const line = leftResource + " ".repeat(leftPad) + campaignName + " ".repeat(rightPad) + rightResources;
    return [top, `${v.vertical} ${line} ${v.vertical}`];
  }

  // Tight fit — just center the campaign name, drop resources if needed
  const pad = Math.max(0, innerWidth - nameLen);
  const padLeft = Math.floor(pad / 2);
  const padRight = pad - padLeft;
  const line = " ".repeat(padLeft) + campaignName + " ".repeat(padRight);
  return [top, `${v.vertical} ${truncateToWidth(line, innerWidth)} ${v.vertical}`];
}

/**
 * Render a vertical frame string for one row of a side border.
 * @param variant - The style variant to use
 * @param side - "left" or "right"
 * @param frameWidth - Width of the side frame in columns (1 or 2)
 * @param ascii - Force ASCII fallback
 */
export function renderVerticalFrame(
  variant: FrameStyleVariant,
  side: "left" | "right",
  frameWidth: 1 | 2 = 1,
  ascii = false,
): string {
  const v = ascii ? ASCII_VARIANT : variant;
  if (frameWidth === 1) {
    return v.vertical;
  }
  // Width 2: border char + padding space (inside edge)
  return side === "left" ? `${v.vertical} ` : ` ${v.vertical}`;
}

/**
 * Approximate string width (handles most common cases).
 * Does not handle full Unicode width detection — just counts characters.
 */
export function stringWidth(str: string): number {
  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Truncate a string to a maximum display width.
 */
export function truncateToWidth(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str;
  if (maxWidth <= 1) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 1) + "…";
}

/**
 * Render a styled content line with left/right vertical borders.
 * Like renderContentLine but accepts FormattingNode[] for styled content.
 */
export function renderStyledContentLine(
  variant: FrameStyleVariant,
  nodes: FormattingNode[],
  width: number,
  ascii = false,
): React.ReactElement {
  const v = ascii ? ASCII_VARIANT : variant;

  if (width < 4) {
    return React.createElement(Text, null, ...renderNodes(nodes));
  }

  const innerWidth = width - 4; // 2 for borders + 2 for padding spaces
  const plainText = toPlainText(nodes);
  const contentLen = stringWidth(plainText);

  // If content fits, use nodes directly; if too long, truncate plain text and re-parse
  let styledNodes: FormattingNode[];
  let pad: number;
  if (contentLen > innerWidth) {
    const truncated = truncateToWidth(plainText, innerWidth);
    styledNodes = parseFormatting(truncated);
    pad = 0;
  } else {
    styledNodes = nodes;
    pad = Math.max(0, innerWidth - contentLen);
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Text, { color: variant.color }, `${v.vertical} `),
    React.createElement(Text, null, ...renderNodes(styledNodes)),
    React.createElement(Text, { color: variant.color }, `${" ".repeat(pad)} ${v.vertical}`),
  );
}
