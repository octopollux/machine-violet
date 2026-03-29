import React from "react";
import { Text, Box } from "ink";
import type { FrameStyleVariant } from "@machine-violet/shared/types/tui.js";
import { renderHorizontalFrame, renderHorizontalFrameParts, renderVerticalFrame } from "../frames/index.js";

interface HorizontalBorderProps {
  variant: FrameStyleVariant;
  width: number;
  position: "top" | "bottom";
  centerText?: string;
  /** When set, the center text is rendered in this color instead of the variant color. */
  centerTextColor?: string;
  ascii?: boolean;
}

/** Renders a horizontal frame border (top or bottom) */
export function HorizontalBorder({
  variant,
  width,
  position,
  centerText,
  centerTextColor,
  ascii,
}: HorizontalBorderProps) {
  if (centerText && centerTextColor) {
    const parts = renderHorizontalFrameParts(variant, width, position, centerText, ascii);
    return (
      <Box>
        <Text color={variant.color}>{parts.left}</Text>
        <Text color={centerTextColor}>{parts.center}</Text>
        <Text color={variant.color}>{parts.right}</Text>
      </Box>
    );
  }
  const line = renderHorizontalFrame(variant, width, position, centerText, ascii);
  return (
    <Box>
      <Text color={variant.color}>{line}</Text>
    </Box>
  );
}

interface SideFrameProps {
  variant: FrameStyleVariant;
  side: "left" | "right";
  height: number;
  /** Width of the frame column in characters (1 or 2). Default 1. */
  frameWidth?: 1 | 2;
  ascii?: boolean;
}

/** Renders a vertical side frame (left or right) as a column of border characters. */
export function SideFrame({
  variant,
  side,
  height,
  frameWidth = 1,
  ascii,
}: SideFrameProps) {
  const ch = renderVerticalFrame(variant, side, frameWidth, ascii);
  return (
    <Box flexDirection="column" width={frameWidth}>
      {Array.from({ length: height }, (_, i) => (
        <Text key={i} color={variant.color}>{ch}</Text>
      ))}
    </Box>
  );
}

