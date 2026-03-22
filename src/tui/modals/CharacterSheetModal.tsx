import React from "react";
import type { FormattingNode } from "../../types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { markdownToTags, parseFormatting } from "../formatting.js";
import { CenteredModal } from "./CenteredModal.js";
import type { CenteredModalHandle } from "./CenteredModal.js";

interface CharacterSheetModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  content: string;
  onDismiss: () => void;
  /** Ref for external scroll control (e.g. mouse wheel override). */
  scrollRef?: React.Ref<CenteredModalHandle>;
  topOffset?: number;
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
  theme,
  width,
  height,
  content,
  onDismiss,
  scrollRef,
  topOffset,
}: CharacterSheetModalProps) {
  const rawLines = content.split("\n");

  let title = "Character Sheet";
  const bodyLines: string[] = [];
  for (const line of rawLines) {
    if (line.startsWith("# ") && title === "Character Sheet") {
      title = line.slice(2).trim();
    } else {
      bodyLines.push(line);
    }
  }

  const styledLines: FormattingNode[][] = bodyLines.map(
    (line) => parseFormatting(colorizeHexStrings(markdownToTags(line))),
  );

  return (
    <CenteredModal
      ref={scrollRef}
      theme={theme}
      width={width}
      height={height}
      title={title}
      lines={bodyLines}
      styledLines={styledLines}
      minWidth={30}
      maxWidth={999}
      widthFraction={0.7}
      topOffset={topOffset}
      onDismiss={onDismiss}
      scrollKeys
    />
  );
}
