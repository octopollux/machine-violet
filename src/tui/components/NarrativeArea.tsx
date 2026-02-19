import React, { useRef, useEffect, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { Text, Box } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode, FormattingTag } from "../../types/tui.js";
import { parseFormatting, highlightQuotes, computeQuoteState, highlightQuotesWithState, healTagBoundaries } from "../formatting.js";

export interface NarrativeAreaHandle {
  scrollBy(delta: number): void;
}

interface NarrativeAreaProps {
  /** Raw DM text (may contain formatting tags) */
  lines: string[];
  /** Maximum rows to display */
  maxRows: number;
  /** Color for quoted dialogue text */
  quoteColor?: string;
}

/** Compute scroll step: 25% of viewport, min 2 if <25, min 1 if <12 */
export function scrollAmount(viewportRows: number): number {
  if (viewportRows < 12) return 1;
  if (viewportRows < 25) return 2;
  return Math.floor(viewportRows * 0.25);
}

/**
 * Scrolling narrative area using ink-scroll-view.
 * Auto-scrolls to bottom when new content arrives (unless user scrolled up).
 * Exposes scrollBy via ref for keyboard scrolling.
 */
export const NarrativeArea = forwardRef<NarrativeAreaHandle, NarrativeAreaProps>(
  function NarrativeArea({ lines, maxRows, quoteColor }, ref) {
  const scrollRef = useRef<ScrollViewRef>(null);
  const [linesBelow, setLinesBelow] = useState(0);
  const atBottomRef = useRef(true);

  // Expose scrollBy to parent (clamped so forward scroll stops at bottom)
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

  // Track scroll position
  const updateScrollState = useCallback(() => {
    const sv = scrollRef.current;
    if (!sv) return;
    const offset = sv.getScrollOffset();
    const bottom = sv.getBottomOffset();
    const below = Math.max(0, bottom - offset);
    setLinesBelow(below);
    atBottomRef.current = below <= 0;
  }, []);

  const handleScroll = useCallback((_offset: number) => {
    updateScrollState();
  }, [updateScrollState]);

  // Auto-scroll to bottom when new content arrives (only if user was at bottom)
  const lastLine = lines[lines.length - 1] ?? "";
  useEffect(() => {
    if (!atBottomRef.current) {
      // User scrolled up — don't auto-scroll, but update indicator
      updateScrollState();
      return;
    }
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToBottom();
      updateScrollState();
    }, 0);
    return () => clearTimeout(timer);
  }, [lines.length, lastLine, maxRows, updateScrollState]);

  // Handle terminal resize
  useEffect(() => {
    const onResize = () => {
      scrollRef.current?.remeasure();
      updateScrollState();
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, [updateScrollState]);

  // Pre-compute quote state across all lines (from original text, not healed)
  const quoteStates = quoteColor ? computeQuoteState(lines) : undefined;

  // Heal formatting tags that span line boundaries
  const healedLines = healTagBoundaries(lines);

  return (
    <Box height={maxRows} flexDirection="column">
      <ScrollView ref={scrollRef} onScroll={handleScroll}>
        {healedLines.map((line, i) => (
          <NarrativeLine
            key={i}
            text={line}
            quoteColor={quoteColor}
            quoteOpen={quoteStates ? (i > 0 && quoteStates[i - 1]) : false}
          />
        ))}
      </ScrollView>
      {linesBelow > 0 && (
        <Box position="absolute" width="100%" marginTop={maxRows - 1} justifyContent="flex-end">
          <Text color="greenBright">{` scroll (${linesBelow}) more `}</Text>
        </Box>
      )}
    </Box>
  );
});

/** A single narrative line with formatting and optional quote highlighting. */
function NarrativeLine({ text, quoteColor, quoteOpen }: { text: string; quoteColor?: string; quoteOpen: boolean }) {
  let nodes = parseFormatting(text);
  if (quoteColor) {
    if (quoteOpen) {
      // This line starts mid-quote — use state-aware highlighting
      nodes = highlightQuotesWithState(nodes, quoteColor, true);
    } else {
      nodes = highlightQuotes(nodes, quoteColor);
    }
  }
  return <Text>{renderNodes(nodes)}</Text>;
}

function renderNodes(nodes: FormattingNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === "string") {
      return <React.Fragment key={i}>{node}</React.Fragment>;
    }
    return <React.Fragment key={i}>{renderTag(node)}</React.Fragment>;
  });
}

function renderTag(tag: FormattingTag): React.ReactNode {
  const children = renderNodes(tag.content);

  switch (tag.type) {
    case "bold":
      return <Text bold>{children}</Text>;
    case "italic":
      return <Text italic>{children}</Text>;
    case "underline":
      return <Text underline>{children}</Text>;
    case "color":
      return <Text color={tag.color}>{children}</Text>;
    case "center":
    case "right":
      return <Text>{children}</Text>;
  }
}
