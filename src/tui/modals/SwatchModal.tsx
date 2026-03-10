import React from "react";
import { Text, Box } from "ink";
import type { ResolvedTheme } from "../themes/types.js";

interface SwatchModalProps {
  theme: ResolvedTheme;
  width: number;
}

/**
 * Swatch visualization modal.
 * Renders the harmony swatch as a 2D grid of colored block characters.
 * Row labels are hundreds-based (0, 100, 200, ...) so they read directly
 * as ThemeColorMap values.
 */
export function SwatchModal({ theme, width }: SwatchModalProps) {
  const { harmonySwatch, colorMap, keyColor } = theme;
  const steps = harmonySwatch[0]?.length ?? 0;

  // Header: step indices
  const stepLabels = Array.from({ length: steps }, (_, i) => String(i).padStart(3));
  const headerLine = "      " + stepLabels.join(" ");

  // Current colorMap assignments for the footer
  const assignments = Object.entries(colorMap)
    .map(([part, value]) => `${part}: ${value}`)
    .join("  ");

  // Compute centering
  const gridWidth = headerLine.length;
  const padLeft = Math.max(0, Math.floor((width - gridWidth) / 2));
  const pad = " ".repeat(padLeft);

  return (
    <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
      {/* Title */}
      <Text dimColor>
        {pad}Swatch: {theme.asset.name} / {theme.variant} / {keyColor}
      </Text>
      <Text>{pad}</Text>

      {/* Column headers */}
      <Text dimColor>{pad}{headerLine}</Text>

      {/* Grid rows */}
      {harmonySwatch.map((row, anchorIdx) => {
        const label = String(anchorIdx * 100).padStart(5) + ":";
        return (
          <Box key={anchorIdx}>
            <Text dimColor>{pad}{label}</Text>
            {row.map((color, stepIdx) => (
              <Text key={stepIdx} color={color.hex}>
                {"  \u2588"}
              </Text>
            ))}
          </Box>
        );
      })}

      <Text>{pad}</Text>

      {/* Footer: current assignments */}
      <Text dimColor>{pad}{assignments}</Text>

      <Text dimColor>
        {pad}Press any key to dismiss
      </Text>
    </Box>
  );
}
