import React from "react";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";

interface RollbackSummaryModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  summary: string;
  onDismiss: () => void;
  topOffset?: number;
}

/**
 * Rollback summary modal. Shows what was rolled back and waits for Enter.
 */
export function RollbackSummaryModal({
  theme,
  width,
  height,
  summary,
  onDismiss,
  topOffset,
}: RollbackSummaryModalProps) {
  const lines = summary.split("\n");
  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Rollback Complete"
      lines={lines}
      footer="Enter to continue"
      minWidth={40}
      maxWidth={50}
      topOffset={topOffset}
      onDismiss={onDismiss}
      scrollKeys
    />
  );
}
