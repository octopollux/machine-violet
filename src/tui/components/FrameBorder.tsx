import React from "react";
import { Text, Box } from "ink";
import type { FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderVerticalFrame, renderContentLine } from "../frames/index.js";

interface HorizontalBorderProps {
  variant: FrameStyleVariant;
  width: number;
  position: "top" | "bottom";
  centerText?: string;
  ascii?: boolean;
}

/** Renders a horizontal frame border (top or bottom) */
export function HorizontalBorder({
  variant,
  width,
  position,
  centerText,
  ascii,
}: HorizontalBorderProps) {
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

interface FramedContentProps {
  variant: FrameStyleVariant;
  width: number;
  content: string;
  ascii?: boolean;
}

/** Renders a content line with left/right vertical borders */
export function FramedContent({
  variant,
  width,
  content,
  ascii,
}: FramedContentProps) {
  const line = renderContentLine(variant, content, width, ascii);
  return (
    <Box>
      <Text color={variant.color}>{line}</Text>
    </Box>
  );
}
