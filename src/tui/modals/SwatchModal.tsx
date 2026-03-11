import React from "react";
import { Text, Box } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";
import { stringWidth } from "../frames/index.js";

interface SwatchModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  topOffset?: number;
}

/** Pad a string to exactly `w` visible characters with trailing spaces. */
function padTo(text: string, w: number): string {
  const pad = Math.max(0, w - stringWidth(text));
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * Swatch visualization modal.
 * Renders the harmony swatch as a 2D grid of colored block characters.
 * Row labels are hundreds-based (0, 100, 200, ...) so they read directly
 * as ThemeColorMap values.
 */
export function SwatchModal({ theme, width, height, topOffset }: SwatchModalProps) {
  const { harmonySwatch, colorMap, keyColor } = theme;
  const steps = harmonySwatch[0]?.length ?? 0;

  // Column headers
  const stepLabels = Array.from({ length: steps }, (_, i) => String(i).padStart(3));
  const headerLine = "      " + stepLabels.join("");

  // Current colorMap assignments
  const assignments = Object.entries(colorMap)
    .map(([part, value]) => `${part}: ${value}`)
    .join("  ");

  const sideWidth = theme.asset.components.edge_left.width;
  const sidePadding = 1;
  const chrome = 2 * sideWidth + 2 * sidePadding;

  // Title drives minimum width: title + padding spaces + corners + separators
  const title = `${theme.asset.name} / ${theme.variant} / ${keyColor}`;
  const { corner_tl, corner_tr, separator_left_top, separator_right_top } = theme.asset.components;
  const titleChrome = corner_tl.width + corner_tr.width
    + separator_left_top.width + separator_right_top.width;
  const titleMinWidth = stringWidth(title) + 2 + titleChrome; // +2 for padding spaces

  const gridContentWidth = headerLine.length;
  const modalWidth = Math.max(gridContentWidth + chrome, titleMinWidth);
  const innerWidth = modalWidth - chrome;

  // Center the grid within the (possibly wider) inner area
  const gridPadLeft = Math.floor((innerWidth - gridContentWidth) / 2);
  const gridPadRight = innerWidth - gridContentWidth - gridPadLeft;
  const leftPad = " ".repeat(gridPadLeft);
  const rightPad = " ".repeat(gridPadRight);

  // Content rows: header + grid rows + blank + assignments
  const contentRows = 1 + harmonySwatch.length + 1 + 1;

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title={title}
      footer="Press any key to dismiss"
      minWidth={modalWidth}
      maxWidth={modalWidth}
      contentHeight={contentRows}
      topOffset={topOffset}
    >
      {/* Column headers */}
      <Text dimColor>{padTo(leftPad + headerLine, innerWidth)}</Text>

      {/* Grid rows — centered and padded to fill innerWidth */}
      {harmonySwatch.map((row, anchorIdx) => {
        const label = String(anchorIdx * 100).padStart(5) + ":";
        const rowWidth = gridPadLeft + stringWidth(label) + row.length * 3 + gridPadRight;
        const trailingPad = Math.max(0, innerWidth - rowWidth);
        return (
          <Box key={anchorIdx}>
            <Text dimColor>{leftPad}{label}</Text>
            {row.map((color, stepIdx) => (
              <Text key={stepIdx} color={color.hex}>
                {"  \u2588"}
              </Text>
            ))}
            <Text>{rightPad}{trailingPad > 0 ? " ".repeat(trailingPad) : ""}</Text>
          </Box>
        );
      })}

      <Text>{" ".repeat(innerWidth)}</Text>

      {/* Current assignments */}
      <Text dimColor>{padTo(assignments, innerWidth)}</Text>
    </CenteredModal>
  );
}
