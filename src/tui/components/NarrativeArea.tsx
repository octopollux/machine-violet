import React, { useRef, useEffect } from "react";
import { Text, Box } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import type { FormattingNode, FormattingTag } from "../../types/tui.js";
import { parseFormatting, toPlainText, highlightQuotes } from "../formatting.js";

/** A parsed conversation turn */
export interface NarrativeTurn {
  kind: "dm" | "player";
  lines: string[];
}

interface NarrativeAreaProps {
  /** Raw DM text (may contain formatting tags) */
  lines: string[];
  /** Maximum rows to display */
  maxRows: number;
  /** Terminal width for full-width backgrounds */
  columns?: number;
  /** Background color for DM turn cards */
  dmBackground?: string;
  /** Color for quoted dialogue text */
  quoteColor?: string;
}

/**
 * Parse narrative lines into turn blocks.
 * Player lines start with "> CharName: ...".
 * Everything else is a DM turn.
 */
export function parseTurns(lines: string[]): NarrativeTurn[] {
  const turns: NarrativeTurn[] = [];
  let current: NarrativeTurn | null = null;

  for (const line of lines) {
    const isPlayer = line.startsWith("> ");
    const kind = isPlayer ? "player" : "dm";

    if (!current || current.kind !== kind) {
      current = { kind, lines: [line] };
      turns.push(current);
    } else {
      current.lines.push(line);
    }
  }

  return turns;
}

/**
 * Scrolling narrative area using ink-scroll-view.
 * Auto-scrolls to bottom when new content arrives.
 */
export function NarrativeArea({ lines, maxRows, columns: cols, dmBackground, quoteColor }: NarrativeAreaProps) {
  const columns = cols ?? 80;
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

  const turns = parseTurns(lines);

  // Build a stable key for each turn based on its starting line index
  let lineIdx = 0;
  const turnEntries = turns.map((turn) => {
    const key = `turn-${lineIdx}`;
    lineIdx += turn.lines.length;
    return { turn, key };
  });

  return (
    <Box height={maxRows} flexDirection="column">
      <ScrollView ref={scrollRef}>
        {turnEntries.map(({ turn, key }) => (
          <TurnCard
            key={key}
            turn={turn}
            dmBackground={dmBackground}
            quoteColor={quoteColor}
            columns={columns}
          />
        ))}
      </ScrollView>
    </Box>
  );
}

/**
 * A single conversation turn rendered as a "card".
 * DM turns get a background color with full-width padding.
 */
function TurnCard({ turn, dmBackground, quoteColor, columns }: {
  turn: NarrativeTurn;
  dmBackground?: string;
  quoteColor?: string;
  columns: number;
}) {
  const bg = turn.kind === "dm" && dmBackground ? dmBackground : undefined;

  if (bg) {
    return (
      <Box flexDirection="column">
        {turn.lines.map((line, i) => (
          <CardLine key={i} text={line} bg={bg} quoteColor={quoteColor} columns={columns} />
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {turn.lines.map((line, i) => (
        <PaddedLine key={i} text={line} quoteColor={quoteColor} columns={columns} />
      ))}
    </Box>
  );
}

/**
 * A line inside a DM card — full-width background.
 */
function CardLine({ text, bg, quoteColor, columns }: {
  text: string;
  bg: string;
  quoteColor?: string;
  columns: number;
}) {
  if (text.trim().length === 0) {
    return <Text backgroundColor={bg}>{" ".repeat(columns)}</Text>;
  }

  const nodes = buildNodes(text, quoteColor);
  const plainLen = toPlainText(parseFormatting(text)).length + 1; // +1 for leading space
  const pad = Math.max(0, columns - (plainLen % columns || columns));

  return (
    <Text backgroundColor={bg}>
      {" "}{renderNodes(nodes)}{pad > 0 ? " ".repeat(pad) : null}
    </Text>
  );
}

/**
 * A non-background line padded to full terminal width.
 */
function PaddedLine({ text, quoteColor, columns }: {
  text: string;
  quoteColor?: string;
  columns: number;
}) {
  if (text.trim().length === 0) {
    return <Text>{" ".repeat(columns)}</Text>;
  }

  const nodes = buildNodes(text, quoteColor);
  const plainLen = toPlainText(parseFormatting(text)).length;
  const pad = Math.max(0, columns - (plainLen % columns || columns));

  return (
    <Text>
      {renderNodes(nodes)}{pad > 0 ? " ".repeat(pad) : null}
    </Text>
  );
}

/** Parse and optionally highlight quotes in a line */
function buildNodes(text: string, quoteColor?: string): FormattingNode[] {
  let nodes = parseFormatting(text);
  if (quoteColor) {
    nodes = highlightQuotes(nodes, quoteColor);
  }
  return nodes;
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
