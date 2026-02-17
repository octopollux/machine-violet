import React from "react";
import { Text, Box } from "ink";
import type { FormattingNode, FormattingTag } from "../../types/tui.js";
import { parseFormatting } from "../formatting.js";

interface NarrativeAreaProps {
  /** Raw DM text (may contain formatting tags) */
  lines: string[];
  /** Maximum rows to display */
  maxRows: number;
}

/**
 * Scrolling narrative text area. Renders DM text with inline formatting.
 * Shows the most recent lines that fit within maxRows.
 */
export function NarrativeArea({ lines, maxRows }: NarrativeAreaProps) {
  // Show the last maxRows lines
  const visible = lines.slice(-maxRows);

  return (
    <Box flexDirection="column" height={maxRows}>
      {visible.map((line, i) => (
        <Box key={i}>
          <FormattedText text={line} />
        </Box>
      ))}
    </Box>
  );
}

/** Render a single line of DM text with formatting tags */
function FormattedText({ text }: { text: string }) {
  const nodes = parseFormatting(text);
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
      // Justification is handled at the Box level in a full layout
      // In inline context, just render the content
      return <Text>{children}</Text>;
  }
}
