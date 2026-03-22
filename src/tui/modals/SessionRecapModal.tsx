import React from "react";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";
import type { CenteredModalHandle } from "./CenteredModal.js";

interface SessionRecapModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  lines: string[];
  onDismiss?: () => void;
  /** Ref for external scroll control (e.g. mouse wheel override). */
  scrollRef?: React.Ref<CenteredModalHandle>;
  topOffset?: number;
}

/**
 * Session recap modal. Displays "Previously on..." text at session start.
 * Fixed at 40 columns wide, sized to fit the conversation pane.
 */
export function SessionRecapModal({
  theme,
  width,
  height,
  lines,
  onDismiss,
  scrollRef,
  topOffset,
}: SessionRecapModalProps) {
  return (
    <CenteredModal
      ref={scrollRef}
      theme={theme}
      width={width}
      height={height}
      title="Previously on..."
      lines={lines}
      footer="ESC or Enter to continue"
      minWidth={40}
      maxWidth={40}
      topOffset={topOffset}
      onDismiss={onDismiss}
      scrollKeys
    />
  );
}
