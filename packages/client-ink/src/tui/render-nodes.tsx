import React from "react";
import { Text } from "ink";
import type { FormattingNode, FormattingTag } from "@machine-violet/shared/types/tui.js";

/** Render a FormattingNode tree into React elements for Ink. */
export function renderNodes(nodes: FormattingNode[]): React.ReactNode[] {
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
      // Alignment is handled at the NarrativeLine level when this is a
      // top-level tag. Nested inside other formatting, render children inline.
      return <Text>{children}</Text>;
  }
}
