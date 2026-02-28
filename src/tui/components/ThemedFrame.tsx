/**
 * Themed frame components for the two-pane layout.
 * Replaces FrameBorder.tsx with multi-line ASCII art borders.
 */

import React from "react";
import { Text, Box } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import {
  composeTopFrame,
  composeBottomFrame,
  composeSimpleBorder,
  composeSideColumn,
  playerPaneSideChar,
} from "../themes/composer.js";

/** Get hex color for a frame part from the resolved theme's swatch + color map. */
function themeColor(theme: ResolvedTheme, part: keyof ResolvedTheme["colorMap"]): string | undefined {
  const idx = theme.colorMap[part];
  return theme.swatch[idx]?.hex;
}

// --- Themed Horizontal Border ---

interface ThemedHorizontalBorderProps {
  theme: ResolvedTheme;
  width: number;
  position: "top" | "bottom";
  centerText?: string;
  centerTextColor?: string;
}

/**
 * Multi-line themed horizontal border (top or bottom of Conversation Pane).
 * Uses composeTopFrame/composeBottomFrame from the composition engine.
 */
export function ThemedHorizontalBorder({
  theme,
  width,
  position,
  centerText,
  centerTextColor,
}: ThemedHorizontalBorderProps) {
  const frame =
    position === "top"
      ? composeTopFrame(theme.asset, width, centerText)
      : composeBottomFrame(theme.asset, width, centerText);

  const borderColor = themeColor(theme, "border");
  const titleColor = centerTextColor ?? themeColor(theme, "title");

  return (
    <Box flexDirection="column">
      {frame.rows.map((row, i) => {
        // If there's center text and a distinct title color, render in parts
        if (centerText && titleColor && titleColor !== borderColor) {
          const textIdx = row.indexOf(` ${centerText} `);
          if (textIdx >= 0) {
            const before = row.slice(0, textIdx);
            const middle = ` ${centerText} `;
            const after = row.slice(textIdx + middle.length);
            return (
              <Box key={i}>
                <Text color={borderColor}>{before}</Text>
                <Text color={titleColor}>{middle}</Text>
                <Text color={borderColor}>{after}</Text>
              </Box>
            );
          }
        }
        return (
          <Box key={i}>
            <Text color={borderColor}>{row}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// --- Themed Side Frame ---

interface ThemedSideFrameProps {
  theme: ResolvedTheme;
  side: "left" | "right";
  height: number;
}

/**
 * Vertical side frame for Conversation Pane.
 */
export function ThemedSideFrame({ theme, side, height }: ThemedSideFrameProps) {
  const rows = composeSideColumn(theme.asset, side, height);
  const color = themeColor(theme, "sideFrame");
  const frameWidth = theme.asset.components.edge_left.width;

  return (
    <Box flexDirection="column" width={frameWidth}>
      {rows.map((row, i) => (
        <Text key={i} color={color}>
          {row}
        </Text>
      ))}
    </Box>
  );
}

// --- Simple Border (Player Pane) ---

interface SimpleBorderProps {
  theme: ResolvedTheme;
  width: number;
  position: "top" | "bottom";
  color?: string;
}

/**
 * Simple 1-row border for the Player Pane.
 */
export function SimpleBorder({ theme, width, position, color }: SimpleBorderProps) {
  const frame = composeSimpleBorder(theme.playerPaneFrame, width, position);
  const borderColor = color ?? themeColor(theme, "border");

  return (
    <Box>
      <Text color={borderColor}>{frame.rows[0]}</Text>
    </Box>
  );
}

// --- Player Pane Side Edges ---

interface PlayerPaneSideProps {
  theme: ResolvedTheme;
  side: "left" | "right";
  color?: string;
  /** When set, renders a column of side characters spanning this many rows. */
  height?: number;
}

/**
 * Side edge for Player Pane content rows.
 * When height > 1, renders a vertical column of repeated edge characters.
 */
export function PlayerPaneSide({ theme, side, color, height }: PlayerPaneSideProps) {
  const ch = playerPaneSideChar(theme.playerPaneFrame, side);
  const borderColor = color ?? themeColor(theme, "border");
  if (height && height > 1) {
    return (
      <Box flexDirection="column">
        {Array.from({ length: height }, (_, i) => (
          <Text key={i} color={borderColor}>{ch}</Text>
        ))}
      </Box>
    );
  }
  return <Text color={borderColor}>{ch}</Text>;
}
