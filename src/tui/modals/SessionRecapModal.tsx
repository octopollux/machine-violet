import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { CenteredModal } from "./CenteredModal.js";
import type { CenteredModalHandle } from "./CenteredModal.js";

interface SessionRecapModalProps {
  variant: FrameStyleVariant;
  width: number;
  height: number;
  /** Recap text lines — "Previously on..." style summary */
  lines: string[];
  /** Ref for scroll control */
  scrollRef?: React.Ref<CenteredModalHandle>;
  /** Vertical offset for centering within conversation pane */
  topOffset?: number;
}

/**
 * Session recap modal. Displays "Previously on..." text at session start.
 * Fixed at 40 columns wide, sized to fit the conversation pane.
 */
export function SessionRecapModal({
  variant,
  width,
  height,
  lines,
  scrollRef,
  topOffset,
}: SessionRecapModalProps) {
  return (
    <CenteredModal
      ref={scrollRef}
      variant={variant}
      width={width}
      height={height}
      title="Previously on..."
      children={lines}
      footer="ESC or Enter to continue"
      minWidth={40}
      maxWidth={40}
      topOffset={topOffset}
    />
  );
}
