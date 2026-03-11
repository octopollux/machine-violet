import React from "react";
import { Text, Box } from "ink";
import { getActivity } from "../activity.js";

interface ActivityLineProps {
  engineState: string | null;
}

/**
 * Shows what the engine is doing — mapped from in-flight tool calls.
 * Hidden when idle (null state).
 * Retry/connection-loss states are handled by ApiErrorModal instead.
 */
export const ActivityLine = React.memo(function ActivityLine({ engineState }: ActivityLineProps) {
  const activity = getActivity(engineState);
  if (!activity) return null;

  return (
    <Box>
      <Text dimColor>{activity.label}</Text>
    </Box>
  );
});
