import React from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { Modal } from "./Modal.js";

interface DiceRollModalProps {
  theme: ResolvedTheme;
  width: number;
  expression: string;
  rolls: number[];
  kept?: number[];
  total: number;
  reason?: string;
  onDismiss: () => void;
}

/**
 * Dramatic dice roll display modal.
 * Shows expression, individual rolls, kept dice, and total.
 */
export function DiceRollModal({
  theme,
  width,
  expression,
  rolls,
  kept,
  total,
  reason,
  onDismiss,
}: DiceRollModalProps) {
  useInput(() => { onDismiss(); });
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

  return <Modal theme={theme} width={width} title="Dice Roll" lines={lines} />;
}
