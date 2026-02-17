import React from "react";
import { Text, Box } from "ink";
import type { FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderContentLine } from "../frames/index.js";

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
