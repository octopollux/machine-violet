import React, { useRef, useEffect, useState, useCallback, useMemo, forwardRef } from "react";
import { Text, Box } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import { parseFormatting, highlightQuotes, computeQuoteState, highlightQuotesWithState, healTagBoundaries } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";
import { useScrollHandle } from "../hooks/useScrollHandle.js";
import type { ScrollHandle } from "../hooks/useScrollHandle.js";

export type NarrativeAreaHandle = ScrollHandle;

interface NarrativeAreaProps {
  /** Raw DM text (may contain formatting tags) */
  lines: string[];
  /** Maximum rows to display */
  maxRows: number;
  /** Color for quoted dialogue text */
  quoteColor?: string;
  /** Available width in columns (enables center/right alignment) */
  width?: number;
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
  function NarrativeArea({ lines, maxRows, quoteColor, width }, ref) {
  const scrollRef = useRef<ScrollViewRef>(null);
  const [linesBelow, setLinesBelow] = useState(0);
  const atBottomRef = useRef(true);

  // Expose scrollBy to parent (clamped so forward scroll stops at bottom)
  useScrollHandle(ref, scrollRef);

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
  const quoteStates = useMemo(
    () => quoteColor ? computeQuoteState(lines) : undefined,
    [quoteColor, lines],
  );

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
            width={width}
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
function NarrativeLine({ text, quoteColor, quoteOpen, width }: {
  text: string;
  quoteColor?: string;
  quoteOpen: boolean;
  width?: number;
}) {
  // Dev mode lines: render with dim grey styling
  if (text.startsWith("[dev]")) {
    return <Text dimColor color="gray">{text}</Text>;
  }

  let nodes = parseFormatting(text);
  if (quoteColor) {
    if (quoteOpen) {
      // This line starts mid-quote — use state-aware highlighting
      nodes = highlightQuotesWithState(nodes, quoteColor, true);
    } else {
      nodes = highlightQuotes(nodes, quoteColor);
    }
  }

  // Check if the entire line is a single center/right alignment tag
  if (width && nodes.length === 1 && typeof nodes[0] !== "string"
      && (nodes[0].type === "center" || nodes[0].type === "right")) {
    const justify = nodes[0].type === "center" ? "center" : "flex-end";
    return (
      <Box width={width} justifyContent={justify}>
        <Text>{renderNodes(nodes[0].content)}</Text>
      </Box>
    );
  }

  return <Text>{renderNodes(nodes)}</Text>;
}

