import React, { useRef, useEffect, useState, useCallback, forwardRef } from "react";
import { Text, Box } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { NarrativeLine, ProcessedLine } from "../../types/tui.js";
import { processNarrativeLines } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";
import { useScrollHandle } from "../hooks/useScrollHandle.js";
import type { ScrollHandle } from "../hooks/useScrollHandle.js";
import { useMouseScroll } from "../hooks/useMouseScroll.js";
import { composeTurnSeparator } from "../themes/composer.js";
import type { ThemeAsset } from "../themes/types.js";

// ---------------------------------------------------------------------------
// Incremental narrative processing hook
// ---------------------------------------------------------------------------

/** Scan backward for last blank DM line; returns index or -1. */
function findLastBlankDm(lines: NarrativeLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === "dm" && lines[i].text.trim() === "") return i;
  }
  return -1;
}

/** Check that the first `count` elements are reference-equal. */
function prefixStable(a: NarrativeLine[], b: NarrativeLine[], count: number): boolean {
  if (a.length < count || b.length < count) return false;
  for (let i = 0; i < count; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Incrementally process narrative lines by caching the "frozen" prefix
 * (everything before the last blank DM line) and only reprocessing
 * the current paragraph tail on each call.
 */
export function useProcessedLines(
  lines: NarrativeLine[],
  width: number,
  quoteColor?: string,
): ProcessedLine[] {
  const cacheRef = useRef<{
    lines: NarrativeLine[];
    width: number;
    quoteColor: string | undefined;
    splitIdx: number;            // index of blank DM line where we split
    frozenResult: ProcessedLine[];
    fullResult: ProcessedLine[];
  } | null>(null);

  const splitIdx = findLastBlankDm(lines);
  const cache = cacheRef.current;

  // Can we reuse the frozen prefix?
  if (
    cache !== null &&
    cache.width === width &&
    cache.quoteColor === quoteColor &&
    cache.splitIdx === splitIdx &&
    splitIdx >= 0 &&
    cache.lines.length <= lines.length &&
    prefixStable(cache.lines, lines, splitIdx + 1)
  ) {
    // Frozen prefix is still valid — only reprocess the tail
    const tail = lines.slice(splitIdx + 1);
    const tailResult = processNarrativeLines(tail, width, quoteColor);
    const fullResult = [...cache.frozenResult, ...tailResult];
    cacheRef.current = {
      lines,
      width,
      quoteColor,
      splitIdx,
      frozenResult: cache.frozenResult,
      fullResult,
    };
    return fullResult;
  }

  // Full recompute
  if (splitIdx >= 0) {
    const prefix = lines.slice(0, splitIdx + 1);
    const tail = lines.slice(splitIdx + 1);
    const frozenResult = processNarrativeLines(prefix, width, quoteColor);
    const tailResult = processNarrativeLines(tail, width, quoteColor);
    const fullResult = [...frozenResult, ...tailResult];
    cacheRef.current = { lines, width, quoteColor, splitIdx, frozenResult, fullResult };
    return fullResult;
  }

  // No blank DM line — no split possible, process everything
  const fullResult = processNarrativeLines(lines, width, quoteColor);
  cacheRef.current = { lines, width, quoteColor, splitIdx, frozenResult: [], fullResult };
  return fullResult;
}

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
  /** Theme asset for rendering turn separators */
  themeAsset?: ThemeAsset;
  /** Color for turn separator lines */
  separatorColor?: string;
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
  function NarrativeArea({ lines, maxRows, quoteColor, playerColor, width, themeAsset, separatorColor }, ref) {
  const scrollRef = useRef<ScrollViewRef>(null);
  const [linesBelow, setLinesBelow] = useState(0);
  const atBottomRef = useRef(true);

  // Expose scrollBy to parent (clamped so forward scroll stops at bottom)
  useScrollHandle(ref, scrollRef);

  // Mouse wheel → single-line scroll (uses raw ScrollViewRef directly)
  useMouseScroll(scrollRef);

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

  // Incremental pipeline: frozen prefix cached, only tail reprocessed
  const processedLines = useProcessedLines(lines, width ?? 0, quoteColor);

  return (
    <Box height={maxRows} flexDirection="column">
      <ScrollView ref={scrollRef} onScroll={handleScroll}>
        {processedLines.map((line, i) => (
          <NarrativeLineComponent
            key={i}
            line={line}
            playerColor={playerColor}
            width={width}
            themeAsset={themeAsset}
            separatorColor={separatorColor}
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

interface NarrativeLineProps {
  line: ProcessedLine;
  playerColor?: string;
  width?: number;
  themeAsset?: ThemeAsset;
  separatorColor?: string;
}

/** A single narrative line rendered based on its kind. */
const NarrativeLineComponent = React.memo(function NarrativeLineComponent({
  line, playerColor, width, themeAsset, separatorColor,
}: NarrativeLineProps) {
  // Separator lines always render the turn separator pattern
  if (line.kind === "separator") {
    if (themeAsset && width && width > 0) {
      const text = composeTurnSeparator(themeAsset, width);
      return <Text wrap="truncate" color={separatorColor} dimColor>{text}</Text>;
    }
    // Fallback: simple dashes
    const fallback = width && width > 4
      ? "─".repeat(width)
      : "────";
    return <Text wrap="truncate" dimColor>{fallback}</Text>;
  }

  // Empty nodes (paragraph breaks) need a space to
  // occupy one terminal line — Ink collapses truly-empty <Text/>.
  const isEmpty = line.nodes.length === 0
    || (line.nodes.length === 1 && line.nodes[0] === "");
  if (isEmpty) {
    return <Text>{" "}</Text>;
  }

  switch (line.kind) {
    case "dev": {
      const raw = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      const text = raw.length > 250 ? raw.slice(0, 250) + "…" : raw;
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
      // Continuation lines from wrapped player text
      return <Text wrap="truncate" color={playerColor}>{text}</Text>;
    }

    case "system": {
      const text = typeof line.nodes[0] === "string" ? line.nodes[0] : "";
      return <Text wrap="truncate" color="yellowBright">{text}</Text>;
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
});
