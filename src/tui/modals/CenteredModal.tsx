import React, { useMemo, useRef, useState, useCallback, useEffect, forwardRef } from "react";
import { Box, Text } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode, FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderHorizontalFrameParts, renderContentLine, renderStyledContentLine, stringWidth } from "../frames/index.js";
import { wrapNodes } from "../formatting.js";
import { useScrollHandle } from "../hooks/useScrollHandle.js";
import type { ScrollHandle } from "../hooks/useScrollHandle.js";

export type CenteredModalHandle = ScrollHandle;

/** Word-wrap a single plain-text line to fit within the given width. */
function wrapPlainLine(text: string, width: number): string[] {
  if (width <= 0 || stringWidth(text) <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (stringWidth(current) + 1 + stringWidth(word) <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

interface CenteredModalProps {
  variant: FrameStyleVariant;
  width: number;
  height: number;
  title?: string;
  children: string[];
  /** Pre-parsed styled content lines (overrides children when present) */
  styledChildren?: FormattingNode[][];
  /** Min width of modal content (default 40) */
  minWidth?: number;
  /** Max width cap (default 60) */
  maxWidth?: number;
  /** Width as fraction of screen (default 0.5) */
  widthFraction?: number;
  /** Text to display in the bottom frame border */
  footer?: string;
  /** Color for the footer text (default "yellow") */
  footerColor?: string;
  /** Vertical offset added to top margin (e.g. to center within conversation pane) */
  topOffset?: number;
}

/**
 * A centered modal overlay with scroll support.
 * Positions itself in the center of the screen using absolute positioning.
 * Content scrolls when it exceeds available height; a scroll indicator shows remaining lines.
 */
export const CenteredModal = forwardRef<CenteredModalHandle, CenteredModalProps>(
  function CenteredModal({
    variant,
    width,
    height,
    title,
    children,
    styledChildren,
    minWidth = 40,
    maxWidth = 60,
    widthFraction = 0.5,
    footer,
    footerColor = "yellow",
    topOffset = 0,
  }, ref) {
    const modalWidth = Math.max(minWidth, Math.min(Math.floor(width * widthFraction), maxWidth));
    const innerWidth = modalWidth - 4; // 2 borders + 2 padding spaces

    // Word-wrap content to fit within modal inner width
    const wrappedChildren = useMemo(
      () => children.flatMap((line) => wrapPlainLine(line, innerWidth)),
      [children, innerWidth],
    );
    const wrappedStyled = useMemo(
      () => styledChildren?.flatMap((line) => wrapNodes(line, innerWidth)),
      [styledChildren, innerWidth],
    );

    const lineCount = wrappedStyled ? wrappedStyled.length : wrappedChildren.length;

    // Max content rows = height minus borders (2) minus 1-line margin top+bottom (2)
    const maxContentRows = Math.max(3, height - 4);
    const needsScroll = lineCount > maxContentRows;
    const visibleRows = needsScroll ? maxContentRows : lineCount;

    // Total modal height = borders (2) + visible content rows
    const modalHeight = visibleRows + 2;
    const topMargin = Math.max(0, topOffset + Math.floor((height - modalHeight) / 2));
    const leftPad = Math.max(0, Math.floor((width - modalWidth) / 2));

    const scrollRef = useRef<ScrollViewRef>(null);
    const [linesBelow, setLinesBelow] = useState(0);

    const updateScrollState = useCallback(() => {
      const sv = scrollRef.current;
      if (!sv) return;
      const offset = sv.getScrollOffset();
      const bottom = sv.getBottomOffset();
      setLinesBelow(Math.max(0, bottom - offset));
    }, []);

    const handleScroll = useCallback((_offset: number) => {
      updateScrollState();
    }, [updateScrollState]);

    // Initial measurement after mount
    useEffect(() => {
      const timer = setTimeout(() => updateScrollState(), 0);
      return () => clearTimeout(timer);
    }, [lineCount, updateScrollState]);

    useScrollHandle(ref, scrollRef);

    const top = renderHorizontalFrame(variant, modalWidth, "top", title);

    // Bottom frame: use parts when footer is present so center can be colored differently
    const bottomFrame = footer
      ? renderHorizontalFrameParts(variant, modalWidth, "bottom", footer)
      : null;
    const bottom = footer ? null : renderHorizontalFrame(variant, modalWidth, "bottom");

    return (
      <Box position="absolute" flexDirection="column" marginTop={topMargin} marginLeft={leftPad}>
        <Box>
          <Text color={variant.color}>{top}</Text>
        </Box>
        <Box height={visibleRows} flexDirection="column">
          <ScrollView ref={scrollRef} onScroll={handleScroll}>
            {wrappedStyled
              ? wrappedStyled.map((nodes, i) => (
                <Box key={i}>
                  {renderStyledContentLine(variant, nodes, modalWidth)}
                </Box>
              ))
              : wrappedChildren.map((line, i) => (
                <Box key={i}>
                  <Text color={variant.color}>
                    {renderContentLine(variant, line, modalWidth)}
                  </Text>
                </Box>
              ))}
          </ScrollView>
          {linesBelow > 0 && (
            <Box position="absolute" width={modalWidth} marginTop={visibleRows - 1} justifyContent="flex-end">
              <Text color="greenBright">{` scroll (${linesBelow}) more `}</Text>
            </Box>
          )}
        </Box>
        <Box>
          {bottomFrame ? (
            <Text>
              <Text color={variant.color}>{bottomFrame.left}</Text>
              <Text color={footerColor}>{bottomFrame.center}</Text>
              <Text color={variant.color}>{bottomFrame.right}</Text>
            </Text>
          ) : (
            <Text color={variant.color}>{bottom}</Text>
          )}
        </Box>
      </Box>
    );
  },
);
