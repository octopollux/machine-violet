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
  playerPaneSideColumn,
} from "../themes/composer.js";
import { colorizeSegments, mirrorT, applyGradient, hexToOklch } from "../color/index.js";
import type { GradientPreset } from "../color/index.js";
import { themeColor } from "../themes/color-resolve.js";

interface BoldSegment {
  text: string;
  bold: boolean;
}

/**
 * Parse `*bold*` markers out of frame center text. Returns the plain string
 * (markers stripped) and a segment list for emphasized rendering.
 *
 * The composer measures by string length to center text on the border, so
 * the marker characters must be gone before it sees the input — width math
 * is done against `plain`, decoration is applied later when we draw the
 * middle span. Used today for the compendium modal footer to bold key
 * names (`*Tab*: next  *Enter*: follow`).
 */
function parseBoldMarkers(text: string): { plain: string; segments: BoldSegment[] } {
  const segments: BoldSegment[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("*", i);
    if (open === -1) {
      const tail = text.slice(i);
      if (tail) segments.push({ text: tail, bold: false });
      plain += tail;
      break;
    }
    if (open > i) {
      const lead = text.slice(i, open);
      segments.push({ text: lead, bold: false });
      plain += lead;
    }
    const close = text.indexOf("*", open + 1);
    if (close === -1) {
      // Unmatched marker — treat as literal so a stray `*` doesn't eat the rest.
      const tail = text.slice(open);
      segments.push({ text: tail, bold: false });
      plain += tail;
      break;
    }
    const inner = text.slice(open + 1, close);
    segments.push({ text: inner, bold: true });
    plain += inner;
    i = close + 1;
  }
  return { plain, segments };
}

/** Render a string with per-character gradient coloring, or flat if no gradient. */
function renderGradientRow(
  row: string,
  baseHex: string | undefined,
  gradient: GradientPreset | undefined,
  offset: number,
  totalLength: number,
  key: React.Key,
): React.ReactNode {
  if (!gradient || !baseHex) {
    return (
      <Box key={key}>
        <Text color={baseHex}>{row}</Text>
      </Box>
    );
  }
  const baseOklch = hexToOklch(baseHex);
  const segments = colorizeSegments(row, gradient, baseOklch, offset, totalLength);
  return (
    <Box key={key}>
      {segments.map((seg, j) => (
        <Text key={j} color={seg.color}>{seg.text}</Text>
      ))}
    </Box>
  );
}

// --- Themed Horizontal Border ---

interface ThemedHorizontalBorderProps {
  theme: ResolvedTheme;
  width: number;
  position: "top" | "bottom";
  /**
   * Center text on the frame's title row(s). Pass an array of strings on
   * `position="top"` to place a continuation chunk on each subsequent
   * row of the top frame (used when the title overflows the head slot).
   */
  centerText?: string | string[];
  centerTextColor?: string;
}

/**
 * Multi-line themed horizontal border (top or bottom of Conversation Pane).
 * Uses composeTopFrame/composeBottomFrame from the composition engine.
 */
export const ThemedHorizontalBorder = React.memo(function ThemedHorizontalBorder({
  theme,
  width,
  position,
  centerText,
  centerTextColor,
}: ThemedHorizontalBorderProps) {
  // Parse `*bold*` markers up-front: composer + row matching see the plain
  // text (so layout math stays correct), while we keep the bold segment
  // structure for rich rendering of the middle span.
  const parsedCenters: { plain: string; segments: BoldSegment[] }[] = Array.isArray(centerText)
    ? centerText.map(parseBoldMarkers)
    : centerText
      ? [parseBoldMarkers(centerText)]
      : [];
  const plainCenters: string[] = parsedCenters.map((p) => p.plain);

  const frame =
    position === "top"
      ? composeTopFrame(theme.asset, width, plainCenters.length > 0 ? plainCenters : undefined)
      : composeBottomFrame(theme.asset, width, plainCenters[0]);

  const borderColor = themeColor(theme, "border");
  const titleColor = centerTextColor ?? themeColor(theme, "title");

  const gradient = theme.gradient;

  // Per-row lookup of which text chunk is on which row. The composer
  // also centers shorter continuations within the longest line's slot,
  // so we trim each chunk to find its actual span in the row string.
  const centerLines: (string | undefined)[] = plainCenters;
  const centerSegments: (BoldSegment[] | undefined)[] = parsedCenters.map((p) => p.segments);

  return (
    <Box flexDirection="column">
      {frame.rows.map((row, i) => {
        const rowText = position === "top" ? centerLines[i] : (i === frame.rows.length - 1 ? centerLines[0] : undefined);
        const rowSegments = position === "top" ? centerSegments[i] : (i === frame.rows.length - 1 ? centerSegments[0] : undefined);
        // If there's center text on this row and a distinct title color, render in parts.
        // The composer centers shorter continuation lines inside the (wider) longest-line
        // slot by inserting extra spaces around the text, so the ` ${rowText} ` substring
        // we used to match no longer exists in that case. Search for rowText directly —
        // the surrounding pad spaces stay border-colored, which is invisible.
        if (rowText && titleColor && titleColor !== borderColor) {
          const textIdx = row.indexOf(rowText);
          if (textIdx >= 0) {
            const before = row.slice(0, textIdx);
            const middle = rowText;
            const after = row.slice(textIdx + middle.length);
            const middleSegments = rowSegments && rowSegments.length > 0
              ? rowSegments
              : [{ text: middle, bold: false }];
            const renderMiddle = middleSegments.map((seg, j) => (
              <Text key={`m${j}`} color={titleColor} bold={seg.bold}>{seg.text}</Text>
            ));

            if (gradient && borderColor) {
              // Gradient the before/after portions with correct offsets
              // so mirrorT sees the full row width for symmetry
              const baseOklch = hexToOklch(borderColor);
              const beforeSegs = colorizeSegments(before, gradient, baseOklch, 0, row.length);
              const afterOffset = textIdx + middle.length;
              const afterSegs = colorizeSegments(after, gradient, baseOklch, afterOffset, row.length);
              return (
                <Box key={i}>
                  {beforeSegs.map((seg, j) => (
                    <Text key={`b${j}`} color={seg.color}>{seg.text}</Text>
                  ))}
                  {renderMiddle}
                  {afterSegs.map((seg, j) => (
                    <Text key={`a${j}`} color={seg.color}>{seg.text}</Text>
                  ))}
                </Box>
              );
            }

            return (
              <Box key={i}>
                <Text color={borderColor}>{before}</Text>
                {renderMiddle}
                <Text color={borderColor}>{after}</Text>
              </Box>
            );
          }
        }
        return renderGradientRow(row, borderColor, gradient, 0, row.length, i);
      })}
    </Box>
  );
});

// --- Themed Side Frame ---

interface ThemedSideFrameProps {
  theme: ResolvedTheme;
  side: "left" | "right";
  height: number;
}

/**
 * Vertical side frame for Conversation Pane.
 */
export const ThemedSideFrame = React.memo(function ThemedSideFrame({ theme, side, height }: ThemedSideFrameProps) {
  const rows = composeSideColumn(theme.asset, side, height);
  const sideHex = themeColor(theme, "sideFrame");
  // Gradient uses the border color as base so hue/chroma shifts match
  // the horizontal borders for cohesive picture-frame symmetry.
  const gradientBaseHex = themeColor(theme, "border") ?? sideHex;
  const frameWidth = theme.asset.components.edge_left.width;
  const gradient = theme.gradient;

  return (
    <Box flexDirection="column" width={frameWidth}>
      {rows.map((row, i) => {
        if (gradient && gradientBaseHex) {
          const t = mirrorT(i, rows.length);
          const rowColor = applyGradient(gradient, hexToOklch(gradientBaseHex), t);
          return (
            <Text key={i} color={rowColor}>
              {row}
            </Text>
          );
        }
        return (
          <Text key={i} color={sideHex}>
            {row}
          </Text>
        );
      })}
    </Box>
  );
});

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
export const SimpleBorder = React.memo(function SimpleBorder({ theme, width, position, color }: SimpleBorderProps) {
  const frame = composeSimpleBorder(theme.playerPaneFrame, width, position);
  const borderColor = color ?? themeColor(theme, "border");

  return (
    <Box>
      <Text color={borderColor}>{frame.rows[0]}</Text>
    </Box>
  );
});

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
 * Renders a vertical column of characters composited from multi-row corners + edge.
 */
export const PlayerPaneSide = React.memo(function PlayerPaneSide({ theme, side, color, height }: PlayerPaneSideProps) {
  const borderColor = color ?? themeColor(theme, "border");
  const h = height ?? 1;
  const chars = playerPaneSideColumn(theme.playerPaneFrame, side, h);
  if (h > 1) {
    return (
      <Box flexDirection="column">
        {chars.map((ch, i) => (
          <Text key={i} color={borderColor}>{ch}</Text>
        ))}
      </Box>
    );
  }
  return <Text color={borderColor}>{chars[0] ?? " "}</Text>;
});
