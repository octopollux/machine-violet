import React, { useMemo, useRef, useState, useEffect } from "react";
import { useInput } from "ink";
import type { Savepoint } from "@machine-violet/shared";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { stringWidth } from "../frames/index.js";
import { CenteredModal, computeModalInnerWidth, type CenteredModalHandle } from "./CenteredModal.js";

const MIN_WIDTH = 48;
const MAX_WIDTH = 72;
const WIDTH_FRACTION = 0.7;

/**
 * Flatten a commit message to a single physical line. Savepoint messages are
 * verbatim player turns, which routinely contain newlines (and tabs, and runs
 * of spaces). A raw `\n` inside a styledLines row makes Ink break the row into
 * two physical lines: CenteredModal sizes its opaque right-pad for the *whole*
 * string, so each broken line is under-padded, and Ink trims the surviving
 * trailing spaces — leaving the narrative behind the modal showing through
 * (full-width background bleed-through). Collapsing whitespace first keeps
 * every row to exactly one line so the opaque padding lands where it should.
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncate `s` to fit `max` columns, adding an ellipsis when clipped. */
function fitWidth(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  if (max <= 1) return "";
  let out = s;
  while (out.length > 0 && stringWidth(out) + 1 > max) out = out.slice(0, -1);
  return out + "…";
}

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

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local-time stamp "Tue 03/06 14:22" (DOW dd/MM hh:mm) from epoch seconds. */
function formatStamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DOW[d.getDay()]} ${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Auto-commit subjects that are synthetic markers, not real player turns. */
const SYNTHETIC = new Set(["initial state", "exchanges"]);

/**
 * Classify a savepoint for display. A real player turn (an `auto` commit whose
 * subject isn't a synthetic fallback) renders as a quoted excerpt; scene /
 * checkpoint / session / character commits and the synthetic auto markers all
 * collapse to a plain "autosave" to keep the list scannable.
 */
function describeSavepoint(sp: Savepoint): { quote: boolean; text: string } {
  if (sp.type === "auto") {
    const subject = sp.message.replace(/^auto:\s*/, "").trim();
    if (subject && !SYNTHETIC.has(subject.toLowerCase())) {
      // Player turns often contain their own dialogue quotes; fold any double
      // quotes (straight or curly) to single quotes so the row carries just
      // the one outer pair we wrap it in — no confusing nested quotes.
      return { quote: true, text: subject.replace(/["“”]/g, "'") };
    }
  }
  return { quote: false, text: "autosave" };
}

/**
 * Roll Back Game — a scrollable, selectable list of git savepoints (newest
 * first). Each row is `<bullet> <stamp>  <body>`, where body is a double-quoted
 * excerpt of the player's turn or the word "autosave" for predictable commit
 * types. Selection cursor mirrors GameMenu; scrolling reuses CenteredModal's
 * ScrollView via ensureLineVisible (as CompendiumModal does).
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

  const footer = empty ? "Esc to go back" : "↑ / ↓ select · Enter to roll back · Esc cancels";

  // Compute the modal's inner width so each row is built as a SINGLE physical
  // line (newlines flattened by oneLine, then message truncated to fit).
  // CenteredModal pads each line full-width and opaque; a row that breaks onto
  // a second physical line leaves the unpadded continuation transparent
  // (background bleed-through) and also desyncs ensureLineVisible(selectedIndex).
  const innerWidth = useMemo(
    () => computeModalInnerWidth(theme, width, { minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH, widthFraction: WIDTH_FRACTION, footer }),
    [theme, width, footer],
  );

  const styledLines: FormattingNode[][] = useMemo(() => {
    if (empty) {
      return [[fitWidth(gitEnabled ? "  No savepoints yet." : "  Rollback unavailable — git is disabled for this campaign.", innerWidth)]];
    }
    return savepoints.map((sp, i) => {
      const isSelected = i === selectedIndex;
      const marker = isSelected ? "◆" : "○";
      const head = `  ${marker} ${formatStamp(sp.timestamp)}  `;
      const { quote, text: subject } = describeSavepoint(sp);
      // Player turns render as a double-quoted excerpt (truncate inside the
      // quotes so the closing quote survives); predictable types show as-is.
      // Flatten newlines first so the whole row stays on one physical line.
      const body = quote
        ? `"${fitWidth(oneLine(subject), Math.max(1, innerWidth - stringWidth(head) - 2))}"`
        : fitWidth(subject, innerWidth - stringWidth(head));
      const text = `${head}${body}`;
      if (isSelected) {
        const bolded: FormattingNode = { type: "bold", content: [text] };
        return [accentColor ? { type: "color", color: accentColor, content: [bolded] } : bolded];
      }
      return [text];
    });
  }, [savepoints, selectedIndex, empty, gitEnabled, accentColor, innerWidth]);

  return (
    <CenteredModal
      ref={scrollRef}
      theme={theme}
      width={width}
      height={height}
      title="Roll Back Game"
      styledLines={styledLines}
      footer={footer}
      minWidth={MIN_WIDTH}
      maxWidth={MAX_WIDTH}
      widthFraction={WIDTH_FRACTION}
      topOffset={topOffset}
    />
  );
}
