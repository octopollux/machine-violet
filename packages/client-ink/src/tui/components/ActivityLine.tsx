import React from "react";
import { Text, Box } from "ink";
import { getActivity } from "../activity.js";
import type { ToolGlyph } from "../activity.js";

interface ActivityLineProps {
  engineState: string | null;
  toolGlyphs?: ToolGlyph[];
}

/**
 * Shows what the engine is doing — mapped from in-flight tool calls.
 * Hidden when idle (null state).
 * Retry/connection-loss states are handled by ApiErrorModal instead.
 *
 * Tool glyphs accumulate as the DM calls tools during a turn,
 * building a visual impression of compounding effort.
 */
export const ActivityLine = React.memo(function ActivityLine({ engineState, toolGlyphs }: ActivityLineProps) {
  const activity = getActivity(engineState);
  if (!activity) return null;

  return (
    <Box>
      <Text dimColor>{activity.label}</Text>
      {toolGlyphs && toolGlyphs.length > 0 && (
        <Text>
          {" "}
          {toolGlyphs.map((tg, i) =>
            tg.color
              ? <Text key={i} color={tg.color}>{tg.glyph}</Text>
              : <Text key={i} dimColor>{tg.glyph}</Text>,
          )}
        </Text>
      )}
    </Box>
  );
});
