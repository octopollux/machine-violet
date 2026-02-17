import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { Modal } from "./Modal.js";

interface CharacterSheetModalProps {
  variant: FrameStyleVariant;
  width: number;
  /** Entity markdown content — front matter lines rendered as-is */
  content: string;
}

/**
 * Character sheet modal. Renders entity markdown as styled modal.
 * Extracts title from first H1 line, shows front matter and body.
 */
export function CharacterSheetModal({
  variant,
  width,
  content,
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

  return <Modal variant={variant} width={width} title={title} children={bodyLines} />;
}
