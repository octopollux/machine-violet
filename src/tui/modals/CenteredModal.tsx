import React, { useMemo, useRef, useState, useCallback, useEffect, forwardRef } from "react";
import { Box, Text } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode } from "../../types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame } from "../components/ThemedFrame.js";
import { themeColor } from "../themes/color-resolve.js";
import { stringWidth } from "../frames/index.js";
import { wrapNodes } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";
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
  theme: ResolvedTheme;
  width: number;
  height: number;
  title?: string;
  /** Plain text content lines */
  lines?: string[];
  /** Pre-parsed styled content lines (takes precedence over lines) */
  styledLines?: FormattingNode[][];
  /** Arbitrary React content (takes precedence over lines and styledLines) */
  children?: React.ReactNode;
  /** Min width of modal content (default 40) */
  minWidth?: number;
  /** Max width cap (default 60) */
  maxWidth?: number;
  /** Width as fraction of screen (default 0.5) */
  widthFraction?: number;
  /** Text to display in the bottom frame border */
  footer?: string;
  /** Color for the footer text */
  footerColor?: string;
  /** Vertical offset added to top margin (e.g. to center within conversation pane) */
  topOffset?: number;
}

/**
 * A centered modal overlay with themed multi-line borders and scroll support.
 * Uses ThemedHorizontalBorder and ThemedSideFrame for the same art-deco
 * borders as the main conversation pane.
 */
export const CenteredModal = forwardRef<CenteredModalHandle, CenteredModalProps>(
  function CenteredModal({
    theme,
    width,
    height,
    title,
    lines,
    styledLines,
    children,
    minWidth = 40,
    maxWidth = 60,
    widthFraction = 0.5,
    footer,
    footerColor,
    topOffset = 0,
  }, ref) {
    const sideWidth = theme.asset.components.edge_left.width;
    const borderHeight = theme.asset.height;
    const sidePadding = 1;

    const modalWidth = Math.max(minWidth, Math.min(Math.floor(width * widthFraction), maxWidth));
    const innerWidth = modalWidth - 2 * sideWidth - 2 * sidePadding;

    // Word-wrap text content
    const wrappedLines = useMemo(
      () => lines?.flatMap((line) => wrapPlainLine(line, innerWidth)) ?? [],
      [lines, innerWidth],
    );
    const wrappedStyled = useMemo(
      () => styledLines?.flatMap((line) => wrapNodes(line, innerWidth)),
      [styledLines, innerWidth],
    );

    const hasReactChildren = children != null;
    const lineCount = hasReactChildren ? 0 : (wrappedStyled ? wrappedStyled.length : wrappedLines.length);

    // Max content rows = height minus themed borders (2 * borderHeight) minus margin (2)
    const maxContentRows = Math.max(3, height - 2 * borderHeight - 2);
    const visibleRows = hasReactChildren
      ? maxContentRows
      : Math.min(lineCount, maxContentRows);

    const modalHeight = visibleRows + 2 * borderHeight;
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

    useEffect(() => {
      const timer = setTimeout(() => updateScrollState(), 0);
      return () => clearTimeout(timer);
    }, [lineCount, updateScrollState]);

    useScrollHandle(ref, scrollRef);

    const textColor = themeColor(theme, "sideFrame");
    const resolvedFooterColor = footerColor ?? themeColor(theme, "title");

    return (
      <Box position="absolute" flexDirection="column" marginTop={topMargin} marginLeft={leftPad}>
        <ThemedHorizontalBorder
          theme={theme}
          width={modalWidth}
          position="top"
          centerText={title}
        />
        <Box height={visibleRows} flexDirection="row">
          <ThemedSideFrame theme={theme} side="left" height={visibleRows} />
          <Box flexDirection="column" width={innerWidth + 2 * sidePadding} paddingLeft={sidePadding} paddingRight={sidePadding}>
            <ScrollView ref={scrollRef} onScroll={handleScroll}>
              {hasReactChildren
                ? <Box flexDirection="column">{children}</Box>
                : wrappedStyled
                  ? wrappedStyled.map((nodes, i) => (
                    <Box key={i}>
                      <Text>{...renderNodes(nodes)}</Text>
                    </Box>
                  ))
                  : wrappedLines.map((line, i) => {
                    const pad = Math.max(0, innerWidth - stringWidth(line));
                    return (
                      <Box key={i}>
                        <Text color={textColor}>{line}{" ".repeat(pad)}</Text>
                      </Box>
                    );
                  })}
            </ScrollView>
            {linesBelow > 0 && (
              <Box position="absolute" width={innerWidth} marginTop={visibleRows - 1} justifyContent="flex-end">
                <Text color="greenBright">{` scroll (${linesBelow}) more `}</Text>
              </Box>
            )}
          </Box>
          <ThemedSideFrame theme={theme} side="right" height={visibleRows} />
        </Box>
        <ThemedHorizontalBorder
          theme={theme}
          width={modalWidth}
          position="bottom"
          centerText={footer}
          centerTextColor={resolvedFooterColor}
        />
      </Box>
    );
  },
);
