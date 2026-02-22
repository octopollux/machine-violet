import React, { useRef, useEffect, useState, useCallback, useMemo, forwardRef } from "react";
import { Text, Box } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { NarrativeLine, ProcessedLine } from "../../types/tui.js";
import { processNarrativeLines } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";
import { useScrollHandle } from "../hooks/useScrollHandle.js";
import type { ScrollHandle } from "../hooks/useScrollHandle.js";

export type NarrativeAreaHandle = ScrollHandle;

interface NarrativeAreaProps {
  /** Typed narrative lines */
  lines: NarrativeLine[];
  /** Maximum rows to display */
  maxRows: number;
  /** Color for quoted dialogue text in DM narration */
  quoteColor?: string;
  /** Color for player speech text */
  playerColor?: string;
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
  function NarrativeArea({ lines, maxRows, quoteColor, playerColor, width }, ref) {
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
  const lastLine = lines[lines.length - 1]?.text ?? "";
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

  // Single-pass AST pipeline: parse → heal → wrap → pad → quote highlight
  const processedLines = useMemo(
    () => processNarrativeLines(lines, width ?? 0, quoteColor),
    [lines, width, quoteColor],
  );

  return (
    <Box height={maxRows} flexDirection="column">
      <ScrollView ref={scrollRef} onScroll={handleScroll}>
        {processedLines.map((line, i) => (
          <NarrativeLineComponent
            key={i}
            line={line}
            playerColor={playerColor}
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

/** A single narrative line rendered based on its kind. */
function NarrativeLineComponent({ line, playerColor, width }: {
  line: ProcessedLine;
  playerColor?: string;
  width?: number;
}) {
  switch (line.kind) {
    case "dev": {
      const text = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      return <Text wrap="truncate" dimColor color="gray">{text}</Text>;
    }

    case "player": {
      const text = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      if (playerColor && text.startsWith("> ")) {
        return (
          <Text wrap="truncate">
            <Text color="greenBright">&gt;</Text>
            <Text color={playerColor}>{text.slice(1)}</Text>
          </Text>
        );
      }
      return <Text wrap="truncate">{text}</Text>;
    }

    case "system": {
      const text = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      return <Text wrap="truncate">{text}</Text>;
    }

    case "dm": {
      // Alignment lines get Box layout
      if (width && line.alignment) {
        const justify = line.alignment === "center" ? "center" : "flex-end";
        // Unwrap the outer alignment tag to get inner content
        const inner = line.nodes.length === 1 && typeof line.nodes[0] !== "string"
          ? line.nodes[0].content
          : line.nodes;
        return (
          <Box width={width} justifyContent={justify}>
            <Text wrap="truncate">{renderNodes(inner)}</Text>
          </Box>
        );
      }

      return <Text wrap="truncate">{renderNodes(line.nodes)}</Text>;
    }
  }
}
