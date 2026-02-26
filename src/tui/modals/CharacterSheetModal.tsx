import React from "react";
import type { FormattingNode, FrameStyleVariant } from "../../types/tui.js";
import { markdownToTags, parseFormatting } from "../formatting.js";
import { CenteredModal } from "./CenteredModal.js";
import type { CenteredModalHandle } from "./CenteredModal.js";

interface CharacterSheetModalProps {
  variant: FrameStyleVariant;
  width: number;
  height: number;
  /** Entity markdown content — front matter lines rendered as-is */
  content: string;
  /** Ref for scroll control */
  scrollRef?: React.Ref<CenteredModalHandle>;
}

/** Wrap bare hex color strings (#rrggbb) in color tags so they render in their own color. */
function colorizeHexStrings(line: string): string {
  return line.replace(/#([0-9a-fA-F]{6})\b/g, (match) => `<color=${match}>${match}</color>`);
}

/**
 * Character sheet modal. Renders entity markdown as styled modal.
 * Extracts title from first H1 line, shows front matter and body.
 * Width: min 30, 70% of screen, no max cap.
 */
export function CharacterSheetModal({
  variant,
  width,
  height,
  content,
  scrollRef,
}: CharacterSheetModalProps) {
  const rawLines = content.split("\n");

  // Extract title from first H1
  let title = "Character Sheet";
  const bodyLines: string[] = [];
  for (const line of rawLines) {
    if (line.startsWith("# ") && title === "Character Sheet") {
      title = line.slice(2).trim();
    } else {
      bodyLines.push(line);
    }
  }

  // Parse markdown → tags → FormattingNode[] for styled rendering
  // colorizeHexStrings wraps #rrggbb strings in <color> tags so they preview in their own color
  const styledLines: FormattingNode[][] = bodyLines.map(
    (line) => parseFormatting(colorizeHexStrings(markdownToTags(line))),
  );

  return (
    <CenteredModal
      ref={scrollRef}
      variant={variant}
      width={width}
      height={height}
      title={title}
      children={bodyLines}
      styledChildren={styledLines}
      minWidth={30}
      maxWidth={999}
      widthFraction={0.7}
    />
  );
}
