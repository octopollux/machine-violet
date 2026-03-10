import React, { useState, useEffect, useRef } from "react";
import type { RetryOverlay } from "../../types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";
import { retryLabel } from "../activity.js";

interface ApiErrorModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  overlay: RetryOverlay;
}

/**
 * Center-screen modal shown during API retry backoff.
 * Owns its own countdown timer that ticks once per second.
 * Auto-dismisses when the parent clears the overlay on successful retry.
 */
export function ApiErrorModal({ theme, width, height, overlay }: ApiErrorModalProps) {
  const [remaining, setRemaining] = useState(overlay.delaySec);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setRemaining(overlay.delaySec);

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [overlay.status, overlay.delaySec]);

  const lines = [
    "",
    `  ${retryLabel(overlay.status)}`,
    "",
    `  Retrying in ${remaining}s...`,
    "",
    "  Will auto-resume on reconnect.",
    "",
  ];

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Connection Error"
      minWidth={36}
      maxWidth={44}
      lines={lines}
    />
  );
}
