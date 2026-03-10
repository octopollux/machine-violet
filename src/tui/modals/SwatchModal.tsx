import React from "react";
import { Text, Box } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";

interface SwatchModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  topOffset?: number;
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
  const headerLine = "      " + stepLabels.join(" ");

  // Current colorMap assignments
  const assignments = Object.entries(colorMap)
    .map(([part, value]) => `${part}: ${value}`)
    .join("  ");

  // Grid needs: title + blank + header + rows + blank + assignments + dismiss = ~N lines
  // Use wide enough modal to fit the grid
  const gridWidth = headerLine.length + 4;

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title={`${theme.asset.name} / ${theme.variant} / ${keyColor}`}
      footer="Press any key to dismiss"
      minWidth={gridWidth}
      maxWidth={gridWidth}
      topOffset={topOffset}
    >
      {/* Column headers */}
      <Text dimColor>{headerLine}</Text>

      {/* Grid rows */}
      {harmonySwatch.map((row, anchorIdx) => {
        const label = String(anchorIdx * 100).padStart(5) + ":";
        return (
          <Box key={anchorIdx}>
            <Text dimColor>{label}</Text>
            {row.map((color, stepIdx) => (
              <Text key={stepIdx} color={color.hex}>
                {"  \u2588"}
              </Text>
            ))}
          </Box>
        );
      })}

      <Text> </Text>

      {/* Current assignments */}
      <Text dimColor>{assignments}</Text>
    </CenteredModal>
  );
}
