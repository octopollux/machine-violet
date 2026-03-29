import React, { useMemo, useRef, useState, useCallback, useEffect, forwardRef } from "react";
import { useInput, Box, Text } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame } from "../components/ThemedFrame.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { stringWidth } from "../frames/index.js";
import { wrapNodes, toPlainText } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";
import { useScrollHandle } from "../hooks/useScrollHandle.js";
import type { ScrollHandle } from "../hooks/useScrollHandle.js";
import { scrollAmount } from "../components/NarrativeArea.js";

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
  /**
   * Pre-rendered row nodes — each must be padded to innerWidth by the caller.
   * CenteredModal adds side padding for opacity but doesn't touch row content.
   * Takes precedence over children, styledLines, and lines.
   */
  rawRows?: React.ReactNode[];
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
  /** Explicit content height (rows) when using children — sizes modal to fit */
  contentHeight?: number;
  /** Called when the user presses ESC or Enter to dismiss the modal. */
  onDismiss?: () => void;
  /**
   * When true, CenteredModal handles keyboard input internally:
   * PageUp/PageDown/arrows/+/- for scrolling, ESC/Enter to call onDismiss.
   * Use for read-only scrollable modals. Leave false for modals with custom input.
   */
  scrollKeys?: boolean;
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
    rawRows,
    children,
    minWidth = 40,
    maxWidth = 60,
    widthFraction = 0.5,
    footer,
    footerColor,
    topOffset = 0,
    contentHeight,
    onDismiss,
    scrollKeys = false,
  }, ref) {
    // Derive modal-specific colors: complementary hue + inverted lightness
    const modalTheme = useMemo(() => deriveModalTheme(theme), [theme]);

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

    const hasRawRows = rawRows != null;
    const hasReactChildren = children != null;
    const lineCount = hasRawRows ? rawRows.length : hasReactChildren ? 0 : (wrappedStyled ? wrappedStyled.length : wrappedLines.length);

    // Max content rows = height minus themed borders (2 * borderHeight) minus margin (2)
    const maxContentRows = Math.max(3, height - 2 * borderHeight - 2);
    const visibleRows = (!hasRawRows && hasReactChildren)
      ? Math.min(contentHeight ?? maxContentRows, maxContentRows)
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

    // Built-in keyboard handling for read-only scrollable modals.
    const scrollBy = useCallback((delta: number) => {
      const sv = scrollRef.current;
      if (!sv) return;
      const offset = sv.getScrollOffset();
      const bottom = sv.getBottomOffset();
      const target = Math.max(0, Math.min(offset + delta, bottom));
      sv.scrollTo(target);
    }, []);

    useInput((input, key) => {
      if (key.escape || key.return) {
        onDismiss?.();
        return;
      }
      const step = scrollAmount(visibleRows);
      if (key.pageUp) { scrollBy(-step); return; }
      if (key.pageDown) { scrollBy(step); return; }
      if (input === "-") { scrollBy(-step); return; }
      if (input === "+") { scrollBy(step); return; }
      if (key.upArrow) { scrollBy(-1); return; }
      if (key.downArrow) { scrollBy(1); return; }
    }, { isActive: scrollKeys });

    const textColor = themeColor(modalTheme, "sideFrame");
    const resolvedFooterColor = footerColor ?? themeColor(modalTheme, "title");

    // Build an opaque blank line that fills the full content area (inner + side padding).
    // Every row in the modal must emit real characters to cover what's behind it.
    const fullRowWidth = innerWidth + 2 * sidePadding;
    const blankLine = " ".repeat(fullRowWidth);
    const padStr = " ".repeat(sidePadding);

    // Pad a plain-text line to exactly innerWidth with trailing spaces.
    const padLine = (line: string): string => {
      const pad = Math.max(0, innerWidth - stringWidth(line));
      return pad > 0 ? line + " ".repeat(pad) : line;
    };

    // Build the full set of visible rows (content + blank fill) so the modal is opaque.
    const contentRows: React.ReactNode[] = [];
    if (hasRawRows) {
      // Raw rows: caller handles inner content; we add side padding for opacity.
      for (let i = 0; i < rawRows.length; i++) {
        contentRows.push(
          <Box key={i} flexDirection="row">
            <Text>{padStr}</Text>
            {rawRows[i]}
            <Text>{padStr}</Text>
          </Box>,
        );
      }
    } else if (hasReactChildren) {
      // React children: wrap with padding columns so edges are opaque
      contentRows.push(
        <Box key="children" flexDirection="row">
          <Text>{padStr}</Text>
          <Box flexDirection="column">{children}</Box>
          <Text>{padStr}</Text>
        </Box>,
      );
    } else if (wrappedStyled) {
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

    // Fill remaining visible rows with blank lines to make the modal opaque.
    // For React children, use the explicit contentHeight so blank rows fill any gap.
    const renderedCount = hasRawRows ? rawRows.length : hasReactChildren ? (contentHeight ?? visibleRows) : (wrappedStyled ? wrappedStyled.length : wrappedLines.length);
    for (let i = renderedCount; i < visibleRows; i++) {
      contentRows.push(
        <Box key={`blank-${i}`}>
          <Text>{blankLine}</Text>
        </Box>,
      );
    }

    return (
      <Box position="absolute" flexDirection="column" marginTop={topMargin} marginLeft={leftPad}>
        <ThemedHorizontalBorder
          theme={modalTheme}
          width={modalWidth}
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
                <Text color="greenBright">{` scroll (${linesBelow}) more `}</Text>
              </Box>
            )}
          </Box>
          <ThemedSideFrame theme={modalTheme} side="right" height={visibleRows} />
        </Box>
        <ThemedHorizontalBorder
          theme={modalTheme}
          width={modalWidth}
          position="bottom"
          centerText={footer}
          centerTextColor={resolvedFooterColor}
        />
      </Box>
    );
  },
);
