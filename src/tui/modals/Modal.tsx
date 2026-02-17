import React from "react";
import { Text, Box } from "ink";
import type { FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderContentLine } from "../frames/index.js";

interface ModalProps {
  variant: FrameStyleVariant;
  width: number;
  title?: string;
  children: string[];
}

/**
 * Base modal component. Renders themed bordered window over content.
 * Children are lines of text to display in the modal body.
 */
export function Modal({ variant, width, title, children }: ModalProps) {
  const top = renderHorizontalFrame(variant, width, "top", title);
  const bottom = renderHorizontalFrame(variant, width, "bottom");

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={variant.color}>{top}</Text>
      </Box>
      {children.map((line, i) => (
        <Box key={i}>
          <Text color={variant.color}>
            {renderContentLine(variant, line, width)}
          </Text>
        </Box>
      ))}
      <Box>
        <Text color={variant.color}>{bottom}</Text>
      </Box>
    </Box>
  );
}
