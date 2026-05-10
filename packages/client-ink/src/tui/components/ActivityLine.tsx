import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { getActivity, getActivityLabel, hasElapsedAwareLabel } from "../activity.js";
import type { ToolGlyph } from "../activity.js";

interface ActivityLineProps {
  engineState: string | null;
  toolGlyphs?: ToolGlyph[];
  /** Wall-clock timestamp (ms) when engineState last changed.
   *  When provided and the state has tiered/elapsed messaging, the label
   *  escalates and an "(Ns)" suffix appears once a few seconds have passed. */
  engineStateSince?: number | null;
}

// Elapsed seconds before we start surfacing the "(Ns)" suffix. Below this,
// the wait feels normal and the count is noise.
const ELAPSED_VISIBLE_THRESHOLD_SEC = 5;

/**
 * Shows what the engine is doing — mapped from in-flight tool calls.
 * Hidden when idle (null state).
 * Retry/connection-loss states are handled by ApiErrorModal instead.
 *
 * Tool glyphs accumulate as the DM calls tools during a turn,
 * building a visual impression of compounding effort.
 *
 * For long-running states (dm_thinking, starting_session), the label
 * escalates through tiers and an elapsed-seconds suffix is appended so
 * a 60-90s silent wait reads as progress instead of a hung UI.
 */
export const ActivityLine = React.memo(function ActivityLine({
  engineState,
  toolGlyphs,
  engineStateSince,
}: ActivityLineProps) {
  const activity = getActivity(engineState);
  const hasGlyphs = !!(toolGlyphs && toolGlyphs.length > 0);

  // Tick every second while a tiered/elapsed-aware state is active so the
  // suffix and tier label stay accurate. The interval is gated on
  // hasElapsedAwareLabel — fast states (roll_dice, rule_lookup) don't get
  // a ticker or an "(Ns)" suffix.
  const elapsedAware = hasElapsedAwareLabel(engineState);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!elapsedAware || !engineStateSince) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [elapsedAware, engineStateSince]);

  // Render whenever we have *anything* to show — an indicator label or
  // accumulated tool glyphs. This keeps the row alive across unmapped or
  // transient engine states (the entire row disappearing — including the
  // glyphs that were already there — reads as "control returned to player").
  if (!activity && !hasGlyphs) return null;

  const elapsedSec = engineStateSince
    ? Math.max(0, Math.floor((Date.now() - engineStateSince) / 1000))
    : 0;
  const tieredLabel = getActivityLabel(engineState, elapsedSec) ?? activity?.label;
  // Suffix is gated on elapsedAware so fast states (roll_dice, rule_lookup)
  // don't grow a "(Ns)" tail just because the player paused before the tool fired.
  const showElapsed = elapsedAware
    && engineStateSince != null
    && elapsedSec >= ELAPSED_VISIBLE_THRESHOLD_SEC;
  const display = tieredLabel
    ? (showElapsed ? `${tieredLabel} (${elapsedSec}s)` : tieredLabel)
    : null;

  return (
    <Box>
      {display && <Text dimColor>{display}</Text>}
      {toolGlyphs && toolGlyphs.length > 0 && (
        <Text>
          {display ? " " : ""}
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
