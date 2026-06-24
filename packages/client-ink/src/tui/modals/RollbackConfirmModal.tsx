import React, { useState } from "react";
import { useInput } from "ink";
import type { Savepoint } from "@machine-violet/shared";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";

export interface RollbackConfirmModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  savepoint: Savepoint;
  /** Number of newer savepoints that will be discarded by rolling back here. */
  discardCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  topOffset?: number;
}

/** Local time "YYYY-MM-DD HH:MM" from epoch seconds. */
function localTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Confirm step before a destructive rollback. Two buttons (default Cancel),
 * mirroring DeleteCampaignModal. Note: the live campaign is backed up to the
 * Archived Campaigns list before the reset, so this is recoverable — the copy
 * says as much.
 */
export function RollbackConfirmModal({
  theme,
  width,
  height,
  savepoint,
  discardCount,
  onConfirm,
  onCancel,
  topOffset,
}: RollbackConfirmModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(1); // default to Cancel

  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSelectedIndex((i) => (i === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      if (selectedIndex === 0) onConfirm();
      else onCancel();
      return;
    }
    if (key.escape) { onCancel(); }
  });

  const stepLabel = discardCount === 1 ? "savepoint" : "savepoints";
  const rollbackLabel = selectedIndex === 0 ? "[Roll Back]" : " Roll Back ";
  const cancelLabel = selectedIndex === 1 ? "[Cancel]" : " Cancel ";

  // Flatten the (potentially multi-line) player-turn message to one line so a
  // raw newline can't break the row and expose the narrative behind the modal
  // (background bleed-through). CenteredModal then wraps/pads it opaquely.
  const message = savepoint.message.replace(/\s+/g, " ").trim();

  const lines = [
    `Roll back to:`,
    `  ${message}`,
    `  ${localTime(savepoint.timestamp)}`,
    "",
    `Discards ${discardCount} later ${stepLabel}.`,
    "A backup is saved to Archived Campaigns first,",
    "so this stays recoverable.",
    "",
    `${rollbackLabel}   ${cancelLabel}`,
  ];

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Roll Back Game?"
      lines={lines}
      minWidth={44}
      maxWidth={60}
      topOffset={topOffset}
    />
  );
}
