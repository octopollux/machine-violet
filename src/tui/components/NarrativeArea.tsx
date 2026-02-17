import React, { useRef, useEffect } from "react";
import { Text, Box } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode, FormattingTag } from "../../types/tui.js";
import { parseFormatting, highlightQuotes } from "../formatting.js";

interface NarrativeAreaProps {
  /** Raw DM text (may contain formatting tags) */
  lines: string[];
  /** Maximum rows to display */
  maxRows: number;
  /** Color for quoted dialogue text */
  quoteColor?: string;
}

/**
 * Scrolling narrative area using ink-scroll-view.
 * Auto-scrolls to bottom when new content arrives.
 */
export function NarrativeArea({ lines, maxRows, quoteColor }: NarrativeAreaProps) {
  const scrollRef = useRef<ScrollViewRef>(null);

  // Auto-scroll to bottom whenever content changes (including mid-line streaming)
  const lastLine = lines[lines.length - 1] ?? "";
  useEffect(() => {
    // Small delay to let ScrollView measure new content first
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToBottom();
    }, 0);
    return () => clearTimeout(timer);
  }, [lines.length, lastLine]);

  // Handle terminal resize
  useEffect(() => {
    const onResize = () => scrollRef.current?.remeasure();
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  return (
    <Box height={maxRows} flexDirection="column">
      <ScrollView ref={scrollRef}>
        {lines.map((line, i) => (
          <NarrativeLine key={i} text={line} quoteColor={quoteColor} />
        ))}
      </ScrollView>
    </Box>
  );
}

/** A single narrative line with formatting and optional quote highlighting. */
function NarrativeLine({ text, quoteColor }: { text: string; quoteColor?: string }) {
  let nodes = parseFormatting(text);
  if (quoteColor) {
    nodes = highlightQuotes(nodes, quoteColor);
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
