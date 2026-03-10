import React from "react";
import { Text, Box } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame } from "../components/ThemedFrame.js";
import { themeColor } from "../themes/color-resolve.js";
import { stringWidth } from "../frames/index.js";

interface ModalProps {
  theme: ResolvedTheme;
  width: number;
  title?: string;
  lines: string[];
}

/**
 * Simple (non-centered) modal with themed borders.
 * Renders below the layout. No scroll support.
 */
export function Modal({ theme, width, title, lines }: ModalProps) {
  const sideWidth = theme.asset.components.edge_left.width;
  const sidePadding = 1;
  const innerWidth = width - 2 * sideWidth - 2 * sidePadding;
  const textColor = themeColor(theme, "sideFrame");

  return (
    <Box flexDirection="column">
      <ThemedHorizontalBorder theme={theme} width={width} position="top" centerText={title} />
      <Box flexDirection="row">
        <ThemedSideFrame theme={theme} side="left" height={lines.length} />
        <Box flexDirection="column">
          {lines.map((line, i) => {
            const pad = Math.max(0, innerWidth - stringWidth(line));
            return (
              <Box key={i} flexDirection="row">
                <Text color={textColor}>{" ".repeat(sidePadding)}{line}{" ".repeat(pad + sidePadding)}</Text>
              </Box>
            );
          })}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={lines.length} />
      </Box>
      <ThemedHorizontalBorder theme={theme} width={width} position="bottom" />
    </Box>
  );
}
