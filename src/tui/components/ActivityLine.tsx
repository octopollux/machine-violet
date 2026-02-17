import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { getActivity, parseRetryState } from "../activity.js";

interface ActivityLineProps {
  engineState: string | null;
}

/**
 * Shows what the engine is doing — mapped from in-flight tool calls.
 * Hidden when idle (null state).
 * For retry states, shows a live countdown.
 */
export function ActivityLine({ engineState }: ActivityLineProps) {
  const [countdown, setCountdown] = useState<number | null>(null);
  const [retryStatus, setRetryStatus] = useState<number | null>(null);

  useEffect(() => {
    if (!engineState) {
      setCountdown(null);
      return;
    }

    const retry = parseRetryState(engineState);
    if (retry) {
      setRetryStatus(retry.status);
      setCountdown(retry.delaySec);

      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) return 0;
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(interval);
    } else {
      setCountdown(null);
      setRetryStatus(null);
    }
  }, [engineState]);

  // Retry countdown active
  if (countdown !== null && retryStatus !== null) {
    return (
      <Box>
        <Text dimColor>⏳ The DM is busy ({retryStatus}) ({countdown}s)</Text>
      </Box>
    );
  }

  const activity = getActivity(engineState);
  if (!activity) return null;

  return (
    <Box>
      <Text dimColor>{activity.label}</Text>
    </Box>
  );
}
