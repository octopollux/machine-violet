import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef } from "react";
import { Box, Text } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderContentLine } from "../frames/index.js";

export interface CenteredModalHandle {
  scrollBy(delta: number): void;
}

interface CenteredModalProps {
  variant: FrameStyleVariant;
  width: number;
  height: number;
  title?: string;
  children: string[];
  /** Min width of modal content (default 40) */
  minWidth?: number;
  /** Max width cap (default 60) */
  maxWidth?: number;
  /** Width as fraction of screen (default 0.5) */
  widthFraction?: number;
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
    minWidth = 40,
    maxWidth = 60,
    widthFraction = 0.5,
  }, ref) {
    const modalWidth = Math.max(minWidth, Math.min(Math.floor(width * widthFraction), maxWidth));

    // Max content rows = screen height minus borders (2) minus some padding (4 top+bottom)
    const maxContentRows = Math.max(3, height - 6);
    const needsScroll = children.length > maxContentRows;
    const visibleRows = needsScroll ? maxContentRows : children.length;

    // Total modal height = borders (2) + visible content rows
    const modalHeight = visibleRows + 2;
    const topMargin = Math.max(0, Math.floor((height - modalHeight) / 2));
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
    }, [children.length, updateScrollState]);

    useImperativeHandle(ref, () => ({
      scrollBy(delta: number) {
        const sv = scrollRef.current;
        if (!sv) return;
        if (delta > 0) {
          const room = sv.getBottomOffset() - sv.getScrollOffset();
          if (room <= 0) return;
          sv.scrollBy(Math.min(delta, room));
        } else {
          sv.scrollBy(delta);
        }
      },
    }), []);

    const top = renderHorizontalFrame(variant, modalWidth, "top", title);
    const bottom = renderHorizontalFrame(variant, modalWidth, "bottom");

    return (
      <Box position="absolute" flexDirection="column" marginTop={topMargin} marginLeft={leftPad}>
        <Box>
          <Text color={variant.color}>{top}</Text>
        </Box>
        <Box height={visibleRows} flexDirection="column">
          <ScrollView ref={scrollRef} onScroll={handleScroll}>
            {children.map((line, i) => (
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
          <Text color={variant.color}>{bottom}</Text>
        </Box>
      </Box>
    );
  },
);
