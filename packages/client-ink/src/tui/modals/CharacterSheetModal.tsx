import React from "react";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";
import type { CenteredModalHandle } from "./CenteredModal.js";
import { colorizeSheetLines, parseFrontMatterLines } from "../character-colorization.js";

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

  // CenteredModal wraps itself in deriveModalTheme — so by the time the
  // colorizer's heading/accent picks land in the frame, anchor 1 IS the
  // frame's primary. Pass frameAnchor: 1 to swing accents back to anchor 0.
  const frontMatter = parseFrontMatterLines(content);
  const styledLines: FormattingNode[][] = colorizeSheetLines(bodyLines, {
    theme,
    frameAnchor: 1,
    frontMatter,
    wikilinks: "preserve",
  });

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
