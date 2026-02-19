import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
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

  return (
    <CenteredModal
      ref={scrollRef}
      variant={variant}
      width={width}
      height={height}
      title={title}
      children={bodyLines}
      minWidth={30}
      maxWidth={999}
      widthFraction={0.7}
    />
  );
}
