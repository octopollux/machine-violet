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

/** Build a cheap content fingerprint for a NarrativeLine slice. */
function tailFingerprint(lines: NarrativeLine[]): string {
  // For short tails (typical during streaming), join texts directly.
  // This is O(n) in tail length but the tail is usually < 20 lines.
  let fp = "";
  for (const l of lines) {
    fp += l.kind;
    fp += ":";
    fp += l.text;
    fp += "\n";
  }
  return fp;
}

/**
 * Incrementally process narrative lines by caching the "frozen" prefix
 * (everything before the last blank DM line) and only reprocessing
 * the current paragraph tail when its content actually changes.
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
    tailFp: string;              // content fingerprint of the tail
    tailResult: ProcessedLine[];
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
    // Frozen prefix is still valid — check if tail content changed
    const tail = lines.slice(splitIdx + 1);
    const fp = tailFingerprint(tail);

    if (fp === cache.tailFp) {
      // Tail content unchanged — return cached result as-is
      return cache.fullResult;
    }

    const tailResult = processNarrativeLines(tail, width, quoteColor);
    const fullResult = [...cache.frozenResult, ...tailResult];
    cacheRef.current = {
      lines,
      width,
      quoteColor,
      splitIdx,
      frozenResult: cache.frozenResult,
      tailFp: fp,
      tailResult,
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
    const fp = tailFingerprint(tail);
    cacheRef.current = { lines, width, quoteColor, splitIdx, frozenResult, tailFp: fp, tailResult, fullResult };
    return fullResult;
  }

  // No blank DM line — no split possible, process everything
  const fp = tailFingerprint(lines);
  if (cache !== null && cache.width === width && cache.quoteColor === quoteColor && cache.splitIdx === -1 && fp === cache.tailFp) {
    return cache.fullResult;
  }
  const fullResult = processNarrativeLines(lines, width, quoteColor);
  cacheRef.current = { lines, width, quoteColor, splitIdx, frozenResult: [], tailFp: fp, tailResult: fullResult, fullResult };
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
  /**
   * When set and `.current` is non-null, mouse scroll targets this handle
   * instead of the narrative. Used to redirect scroll to an overlay modal.
   */
  mouseScrollOverrideRef?: React.RefObject<ScrollHandle | null>;
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
  function NarrativeArea({ lines, maxRows, quoteColor, playerColor, width, themeAsset, separatorColor, mouseScrollOverrideRef }, ref) {
  const scrollRef = useRef<ScrollViewRef>(null);
  const localHandleRef = useRef<ScrollHandle>(null);
  const [linesBelow, setLinesBelow] = useState(0);
  const atBottomRef = useRef(true);

  // Build a clamped ScrollHandle and expose it to both parent and local refs
  useScrollHandle(ref, scrollRef);
  useScrollHandle(localHandleRef, scrollRef);

  // Mouse wheel scroll — routes to override (modal) when active, else narrative.
  // mouseTargetRef is a stable object whose .current is updated each render;
  // the installMouseFilter callback reads .current at event time.
  const mouseTargetRef = useRef<ScrollHandle>(null);
  mouseTargetRef.current = mouseScrollOverrideRef?.current ?? localHandleRef.current;
  useMouseScroll(mouseTargetRef);

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
  // Spacer lines render as visual blank lines (paragraph spacing)
  // but are invisible to the formatting/healing pipeline.
  if (line.kind === "spacer") {
    return <Text>{" "}</Text>;
  }

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
