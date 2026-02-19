import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { Modal } from "./Modal.js";

interface SessionRecapModalProps {
  variant: FrameStyleVariant;
  width: number;
  /** Recap text lines — "Previously on..." style summary */
  lines: string[];
}

/**
 * Session recap modal. Displays "Previously on..." text at session start.
 */
export function SessionRecapModal({
  variant,
  width,
  lines,
}: SessionRecapModalProps) {
  const body = ["Previously on...", "", ...lines, "", "[Press ESC or Enter to continue]"];

  return <Modal variant={variant} width={width} title="Session Recap" children={body} />;
}
