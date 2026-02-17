import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { Modal } from "./Modal.js";

interface ChoiceModalProps {
  variant: FrameStyleVariant;
  width: number;
  prompt: string;
  choices: string[];
}

/**
 * Player choice modal. Shows prompt + labeled options (A/B/C).
 */
export function ChoiceModal({
  variant,
  width,
  prompt,
  choices,
}: ChoiceModalProps) {
  const labels = "ABCDEFGHIJ";
  const lines: string[] = [
    prompt,
    "",
    ...choices.map((c, i) => `${labels[i]}) ${c}`),
    "",
    "> _",
  ];

  return <Modal variant={variant} width={width} title="Choose" children={lines} />;
}
