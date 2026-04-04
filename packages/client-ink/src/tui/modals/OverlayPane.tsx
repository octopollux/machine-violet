/**
 * OverlayPane — a right-aligned overlay that renders inside the narrative pane.
 *
 * Analogous to CenteredModal but anchored to the right edge. Uses themed
 * borders in the complementary (modal) color scheme. Designed for transient
 * info panels toggled by hotkeys (character sheet, inventory, etc.).
 *
 * The pane is opaque — every row is padded with spaces to cover the narrative
 * text behind it. Text does not reflow; the pane simply paints over the
 * rightmost columns.
 */
import React, { useMemo, useRef, useState, useCallback, useEffect } from "react";
import { Box, Text } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame } from "../components/ThemedFrame.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { stringWidth } from "../frames/index.js";
import { wrapNodes, toPlainText } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";

export interface OverlayPaneProps {
  theme: ResolvedTheme;
  /** Total width of the narrative area (used to compute left offset). */
  narrativeWidth: number;
  /** Total height available for the pane (narrative row count). */
  narrativeHeight: number;
  /** Fixed width of the pane in columns. */
  paneWidth: number;
  /** Title text centered in the top border. */
  title?: string;
  /** Plain text content lines. */
  lines?: string[];
  /** Pre-parsed styled content lines (takes precedence over lines). */
  styledLines?: FormattingNode[][];
  /** Vertical offset from the top of the narrative area. */
  topOffset?: number;
}

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

/**
 * A right-aligned overlay pane with themed multi-line borders.
 * Renders on top of the narrative area content using absolute positioning.
 */
export function OverlayPane({
  theme,
  narrativeWidth,
  narrativeHeight,
  paneWidth,
  title,
  lines,
  styledLines,
  topOffset = 0,
}: OverlayPaneProps) {
  const modalTheme = useMemo(() => deriveModalTheme(theme), [theme]);

  const sideWidth = theme.asset.components.edge_left.width;
  const borderHeight = theme.asset.height;
  const sidePadding = 1;

  const clampedWidth = Math.min(paneWidth, narrativeWidth);
  const innerWidth = clampedWidth - 2 * sideWidth - 2 * sidePadding;

  // Word-wrap content
  const wrappedLines = useMemo(
    () => lines?.flatMap((line) => wrapPlainLine(line, innerWidth)) ?? [],
    [lines, innerWidth],
  );
  const wrappedStyled = useMemo(
    () => styledLines?.flatMap((line) => wrapNodes(line, innerWidth)),
    [styledLines, innerWidth],
  );

  const lineCount = wrappedStyled ? wrappedStyled.length : wrappedLines.length;

  // Max content rows = narrative height minus themed borders (2 * borderHeight)
  const maxContentRows = Math.max(3, narrativeHeight - 2 * borderHeight);
  const visibleRows = Math.min(lineCount, maxContentRows);

  // Position: right-aligned inside the narrative area
  const leftMargin = Math.max(0, narrativeWidth - clampedWidth);

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

  const textColor = themeColor(modalTheme, "sideFrame");
  const fullRowWidth = innerWidth + 2 * sidePadding;
  const blankLine = " ".repeat(fullRowWidth);
  const padStr = " ".repeat(sidePadding);

  const padLine = (line: string): string => {
    const pad = Math.max(0, innerWidth - stringWidth(line));
    return pad > 0 ? line + " ".repeat(pad) : line;
  };

  // Build content rows
  const contentRows: React.ReactNode[] = [];
  if (wrappedStyled) {
    for (let i = 0; i < wrappedStyled.length; i++) {
      const plainLen = stringWidth(toPlainText(wrappedStyled[i]));
      const styledPad = Math.max(0, innerWidth - plainLen);
      contentRows.push(
        <Box key={i}>
          <Text>{padStr}</Text>
          <Text>{...renderNodes(wrappedStyled[i])}</Text>
          <Text>{" ".repeat(styledPad)}{padStr}</Text>
        </Box>,
      );
    }
  } else {
    for (let i = 0; i < wrappedLines.length; i++) {
      contentRows.push(
        <Box key={i}>
          <Text color={textColor}>{padStr}{padLine(wrappedLines[i])}{padStr}</Text>
        </Box>,
      );
    }
  }

  // Fill remaining visible rows with blank lines for opacity
  const renderedCount = wrappedStyled ? wrappedStyled.length : wrappedLines.length;
  for (let i = renderedCount; i < visibleRows; i++) {
    contentRows.push(
      <Box key={`blank-${i}`}>
        <Text>{blankLine}</Text>
      </Box>,
    );
  }

  return (
    <Box position="absolute" flexDirection="column" marginTop={topOffset} marginLeft={leftMargin}>
      <ThemedHorizontalBorder
        theme={modalTheme}
        width={clampedWidth}
        position="top"
        centerText={title}
      />
      <Box height={visibleRows} flexDirection="row">
        <ThemedSideFrame theme={modalTheme} side="left" height={visibleRows} />
        <Box flexDirection="column" width={fullRowWidth}>
          <ScrollView ref={scrollRef} onScroll={handleScroll}>
            {contentRows}
          </ScrollView>
          {linesBelow > 0 && (
            <Box position="absolute" width={fullRowWidth} marginTop={visibleRows - 1} justifyContent="flex-end">
              <Text color="greenBright">{` (${linesBelow}) `}</Text>
            </Box>
          )}
        </Box>
        <ThemedSideFrame theme={modalTheme} side="right" height={visibleRows} />
      </Box>
      <ThemedHorizontalBorder
        theme={modalTheme}
        width={clampedWidth}
        position="bottom"
      />
    </Box>
  );
}
