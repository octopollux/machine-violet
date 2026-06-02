import React, { useMemo, useRef, useState, useEffect } from "react";
import { useInput } from "ink";
import type { Savepoint } from "@machine-violet/shared";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { CenteredModal, type CenteredModalHandle } from "./CenteredModal.js";

export interface RollbackPickerModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  savepoints: Savepoint[];
  gitEnabled: boolean;
  /** Called with the chosen savepoint and its index (= count of newer savepoints discarded). */
  onSelect: (savepoint: Savepoint, index: number) => void;
  onCancel: () => void;
  topOffset?: number;
}

/** Relative time like "2m ago", "3h ago", "5d ago" from epoch seconds. */
function relativeTime(epochSeconds: number, now: number): string {
  const sec = Math.max(0, Math.floor(now / 1000) - epochSeconds);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Roll Back Game — a scrollable, selectable list of git savepoints (newest
 * first). Each row shows the commit message (for `auto` commits this is the
 * player's verbatim turn) plus a relative time; non-`auto` commits are tagged
 * with their type. Selection cursor mirrors GameMenu; scrolling reuses
 * CenteredModal's ScrollView via ensureLineVisible (as CompendiumModal does).
 */
export function RollbackPickerModal({
  theme,
  width,
  height,
  savepoints,
  gitEnabled,
  onSelect,
  onCancel,
  topOffset,
}: RollbackPickerModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const scrollRef = useRef<CenteredModalHandle>(null);
  // Stamped once on mount so the relative-time labels don't churn between
  // renders (Date.now() in render would recompute on every keypress).
  const now = useMemo(() => Date.now(), []);
  const empty = !gitEnabled || savepoints.length === 0;

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (empty) return;
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(savepoints.length - 1, i + 1)); return; }
    if (key.return) { onSelect(savepoints[selectedIndex], selectedIndex); return; }
  });

  // Keep the cursored row within the scroll viewport.
  useEffect(() => {
    scrollRef.current?.ensureLineVisible(selectedIndex);
  }, [selectedIndex]);

  const accentColor = useMemo(() => themeColor(deriveModalTheme(theme), "title"), [theme]);

  const styledLines: FormattingNode[][] = useMemo(() => {
    if (empty) {
      return [[gitEnabled ? "  No savepoints yet." : "  Rollback unavailable — git is disabled for this campaign."]];
    }
    return savepoints.map((sp, i) => {
      const isSelected = i === selectedIndex;
      const marker = isSelected ? "◆" : "○";
      const tag = sp.type !== "auto" ? `[${sp.type}] ` : "";
      const when = relativeTime(sp.timestamp, now);
      const text = `${marker} ${tag}${sp.message}  (${when})`;
      if (isSelected) {
        const bolded: FormattingNode = { type: "bold", content: [text] };
        return ["  ", accentColor ? { type: "color", color: accentColor, content: [bolded] } : bolded];
      }
      return [`  ${text}`];
    });
  }, [savepoints, selectedIndex, empty, gitEnabled, accentColor, now]);

  const footer = empty ? "Esc to go back" : "↑ / ↓ select · Enter to roll back · Esc cancels";

  return (
    <CenteredModal
      ref={scrollRef}
      theme={theme}
      width={width}
      height={height}
      title="Roll Back Game"
      styledLines={styledLines}
      footer={footer}
      minWidth={48}
      maxWidth={72}
      widthFraction={0.7}
      topOffset={topOffset}
    />
  );
}
