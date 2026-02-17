import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { Modal } from "./Modal.js";

interface ChoiceModalProps {
  variant: FrameStyleVariant;
  width: number;
  prompt: string;
  choices: string[];
  selectedIndex: number;
}

/**
 * Player choice modal. Shows prompt + selectable options with arrow cursor.
 */
export function ChoiceModal({
  variant,
  width,
  prompt,
  choices,
  selectedIndex,
}: ChoiceModalProps) {
  const lines: string[] = [
    prompt,
    "",
    ...choices.map((c, i) => `${i === selectedIndex ? ">" : " "} ${c}`),
    "",
    "Arrow keys to select, Enter to confirm, ESC to dismiss.",
  ];

  return <Modal variant={variant} width={width} title="Choose" children={lines} />;
}
