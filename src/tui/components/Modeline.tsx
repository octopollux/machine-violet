import React from "react";
import { Text, Box } from "ink";

interface ModelineProps {
  text: string;
  activityGlyph?: string;
  turnInfo?: string;
  width?: number;
}

/**
 * Nethack-style status line. Freeform text set by the DM.
 * Can optionally prefix with activity glyph (when activity line is dropped)
 * and turn info (when lower frame is dropped).
 */
export function Modeline({
  text,
  activityGlyph,
  turnInfo,
  width,
}: ModelineProps) {
  const parts: string[] = [];
  if (activityGlyph) parts.push(activityGlyph);
  if (turnInfo) parts.push(`[${turnInfo}]`);
  parts.push(text);
  const display = parts.join(" ");

  return (
    <Box width={width}>
      <Text wrap="truncate">{display}</Text>
    </Box>
  );
}
