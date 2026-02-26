import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { Modal } from "./Modal.js";

interface DiceRollModalProps {
  variant: FrameStyleVariant;
  width: number;
  expression: string;
  rolls: number[];
  kept?: number[];
  total: number;
  reason?: string;
}

/**
 * Dramatic dice roll display modal.
 * Shows expression, individual rolls, kept dice, and total.
 */
export function DiceRollModal({
  variant,
  width,
  expression,
  rolls,
  kept,
  total,
  reason,
}: DiceRollModalProps) {
  const lines: string[] = [];

  if (reason) {
    lines.push(reason);
    lines.push("");
  }

  lines.push(`Rolling: ${expression}`);
  lines.push("");
  lines.push(`Dice: [ ${rolls.join("  ")} ]`);

  if (kept && kept.length !== rolls.length) {
    lines.push(`Kept: [ ${kept.join("  ")} ]`);
  }

  lines.push("");
  lines.push(`Total: ${total}`);

  return <Modal variant={variant} width={width} title="Dice Roll" children={lines} />;
}
