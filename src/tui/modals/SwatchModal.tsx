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

  // Compute inner content width (same formula as CenteredModal)
  const sideWidth = theme.asset.components.edge_left.width;
  const sidePadding = 1;
  const gridWidth = headerLine.length + 2 * sideWidth + 2 * sidePadding;
  const innerWidth = gridWidth - 2 * sideWidth - 2 * sidePadding;

  // Content rows: header + grid rows + blank + assignments
  const contentRows = 1 + harmonySwatch.length + 1 + 1;

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Color Swatch"
      footer="Press any key to dismiss"
      minWidth={gridWidth}
      maxWidth={gridWidth}
      contentHeight={contentRows + 1}
      topOffset={topOffset}
    >
      {/* Theme info */}
      <Text dimColor>{padTo(`${theme.asset.name} / ${theme.variant} / ${keyColor}`, innerWidth)}</Text>

      {/* Column headers */}
      <Text dimColor>{padTo(headerLine, innerWidth)}</Text>

      {/* Grid rows — pad short rows to fill innerWidth */}
      {harmonySwatch.map((row, anchorIdx) => {
        const label = String(anchorIdx * 100).padStart(5) + ":";
        const rowWidth = stringWidth(label) + row.length * 3;
        const trailingPad = Math.max(0, innerWidth - rowWidth);
        return (
          <Box key={anchorIdx}>
            <Text dimColor>{label}</Text>
            {row.map((color, stepIdx) => (
              <Text key={stepIdx} color={color.hex}>
                {"  \u2588"}
              </Text>
            ))}
            {trailingPad > 0 && <Text>{" ".repeat(trailingPad)}</Text>}
          </Box>
        );
      })}

      <Text>{" ".repeat(innerWidth)}</Text>

      {/* Current assignments */}
      <Text dimColor>{padTo(assignments, innerWidth)}</Text>
    </CenteredModal>
  );
}
