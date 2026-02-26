import React from "react";
import { Text, Box } from "ink";

interface ModelineProps {
  lines: string[];
  width?: number;
}

/**
 * Assemble the raw modeline display string from its parts.
 */
export function buildModelineDisplay(
  text: string,
  activityGlyph?: string,
  turnInfo?: string,
): string {
  const parts: string[] = [];
  if (activityGlyph) parts.push(activityGlyph);
  if (turnInfo) parts.push(`[${turnInfo}]`);
  parts.push(text);
  return parts.join(" ");
}

/**
 * Split a modeline string into multiple lines by breaking at ` | ` boundaries.
 * Segments are greedily packed; the ` | ` at the break point is consumed.
 * A segment that alone exceeds width gets its own (truncated) line.
 */
export function splitModeline(text: string, width: number): string[] {
  if (text.length <= width) return [text];

  const segments = text.split(" | ");
  const lines: string[] = [];
  let current = segments[0];

  for (let i = 1; i < segments.length; i++) {
    const candidate = current + " | " + segments[i];
    if (candidate.length <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = segments[i];
    }
  }
  lines.push(current);

  return lines;
}

/**
 * Nethack-style status line. Freeform text set by the DM.
 * Receives pre-split lines from the layout (so the layout can account
 * for the line count when sizing the narrative area).
 */
export function Modeline({ lines, width }: ModelineProps) {
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">{line}</Text>
      ))}
    </Box>
  );
}
