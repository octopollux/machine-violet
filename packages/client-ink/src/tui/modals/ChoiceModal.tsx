import React, { useState, useEffect, useRef } from "react";
import { useInput, Box, Text } from "ink";
import type { FrameStyleVariant } from "@machine-violet/shared/types/tui.js";
import { renderHorizontalFrame, renderContentLine } from "../frames/index.js";
import { InlineTextInput } from "../components/InlineTextInput.js";
import { parseFormatting, stripFormatting, stripLeadingBullet, wrapNodes, nodeVisibleLength } from "../formatting.js";
import { renderNodes } from "../render-nodes.js";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";

/* ──────────────────────────────────────────────────────────
 * ChoiceOverlay — frameless version that fills the Player Pane interior.
 * No borders; fits inside the Player Pane content area.
 * ────────────────────────────────────────────────────────── */

/** Number of fixed rows reserved for the description region. */
export const DESCRIPTION_ROWS = 3;

/** Word-wrap formatted text to fit within a given width, returning exactly `rows` lines of FormattingNode[]. */
function wrapToFixedRows(text: string, maxWidth: number, rows: number): FormattingNode[][] {
  if (!text) return Array.from({ length: rows }, () => [] as FormattingNode[]);
  const nodes = parseFormatting(text);
  const wrapped = wrapNodes(nodes, maxWidth);
  // Pad to exact row count
  while (wrapped.length < rows) wrapped.push([]);
  // Truncate if too many lines, adding ellipsis
  if (wrapped.length > rows) {
    wrapped.length = rows;
    const lastLine = wrapped[rows - 1];
    if (nodeVisibleLength(lastLine) > maxWidth - 1) {
      wrapped[rows - 1] = [...lastLine.slice(0, -1), "…"];
    } else {
      wrapped[rows - 1] = [...lastLine, "…"];
    }
  }
  return wrapped;
}

interface ChoiceOverlayProps {
  /** Inner width (cols - 2, between Player Pane side edges) */
  width: number;
  prompt: string;
  choices: string[];
  /** Per-choice descriptions shown in a fixed-height region for the highlighted choice. */
  descriptions?: string[];
  /** Hex color for the selection cursor (">"). Falls back to default text color. */
  accentColor?: string;
  /** Max visual rows for choice items. Defaults to MAX_CHOICE_ROWS (5). */
  maxChoiceRows?: number;
  /** Initial selection index. 0 = "Enter your own" (always at the top); 1..choices.length = regular choices. */
  initialIndex?: number;
  /** Called when the player selects a choice (text) or submits custom input. */
  onSelect: (choice: string) => void;
  /** Called for PageUp/PageDown to scroll the narrative area behind the overlay. */
  onNarrativeScroll?: (delta: number) => void;
  /**
   * When false, the overlay stops consuming keystrokes and the custom-input
   * row is read-only. Use this when a modal/menu opens above the choices so
   * arrow keys and Enter don't drive both UIs simultaneously. Defaults to true.
   */
  isActive?: boolean;
}

/** Maximum visual rows available for choice items. */
const MAX_CHOICE_ROWS = 5;

/**
 * Frameless choice list for embedding inside the Player Pane.
 *
 * "Enter your own" always sits at the top of the choice list (index 0).
 * Choices are top-anchored: as items wrap to more visual rows, the list
 * extends downward (pushing later options down) while the freeform row
 * stays put.
 *
 * Without descriptions — 7-row layout:
 *   Row 0: prompt text
 *   Rows 1-5: choices (scrolled, line-wrapped; ▲/▼ in left margin)
 *   Row 6: right-aligned help hint
 *
 * With descriptions — 10-row layout:
 *   Row 0: prompt text
 *   Rows 1-3: fixed-height description of highlighted choice (dimmed)
 *   Rows 4-8: choices (scrolled, line-wrapped; ▲/▼ in left margin)
 *   Row 9: right-aligned help hint
 *
 * Scroll indicators (▲/▼) live in a dedicated first column at the
 * top-left of the choice region (row 0 = ▲, row 1 = ▼). The cursor
 * (>) occupies the second column. The two never interfere.
 */
export function ChoiceOverlay({
  width,
  prompt,
  choices: rawChoices,
  descriptions,
  accentColor,
  maxChoiceRows: maxChoiceRowsProp,
  initialIndex,
  onSelect,
  onNarrativeScroll,
  isActive = true,
}: ChoiceOverlayProps) {
  const choices = Array.isArray(rawChoices)
    ? rawChoices.map((c) => (typeof c === "string" ? c : String(c)))
    : [];

  const showCustomInput = true;
  const totalOptions = choices.length + 1; // +1 for "Enter your own" (index 0)
  // "Enter your own" sits at index 0. For short lists, default focus there
  // so the player can type without navigating; for long lists, default to
  // the first real choice (index 1).
  const defaultIndex = initialIndex ?? (choices.length < 5 ? 0 : 1);
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex);
  const [customInputActive, setCustomInputActive] = useState(defaultIndex === 0);
  const [customInputResetKey, setCustomInputResetKey] = useState(0);
  // Mirrors the InlineTextInput's current value so the parent can size the
  // custom-active row to its actual wrapped height (and the scroll/budget
  // logic can count those lines).
  const [customInputValue, setCustomInputValue] = useState("");
  const scrollStartRef = useRef(0);

  // Reset state when choices change (e.g. choice-generator replaces DM-provided choices).
  // Keyed on the serialized choices array so we only reset when actual options change.
  const choicesKey = rawChoices.join("\0");
  useEffect(() => {
    const idx = initialIndex ?? (choices.length < 5 ? 0 : 1);
    setSelectedIndex(idx);
    setCustomInputActive(idx === 0);
    setCustomInputResetKey((k) => k + 1);
    setCustomInputValue("");
    scrollStartRef.current = 0;
  }, [choicesKey, initialIndex, choices.length]);

  useInput((input, key) => {
    if (customInputActive) {
      if (key.escape) { setCustomInputActive(false); return; }
      if (key.downArrow) {
        setCustomInputActive(false);
        setCustomInputResetKey((k) => k + 1);
        setCustomInputValue("");
        setSelectedIndex(choices.length > 0 ? 1 : 0);
        return;
      }
      if (key.pageUp || key.pageDown) {
        onNarrativeScroll?.(key.pageUp ? -1 : 1);
        return;
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => {
        const next = Math.max(0, i - 1);
        if (next === 0) setCustomInputActive(true);
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(totalOptions - 1, i + 1));
      return;
    }
    if (key.return) {
      if (selectedIndex === 0) {
        setCustomInputActive(true);
        return;
      }
      const chosen = stripLeadingBullet(stripFormatting(choices[selectedIndex - 1]));
      onSelect(chosen);
      return;
    }
    if (key.pageUp || key.pageDown) {
      onNarrativeScroll?.(key.pageUp ? -1 : 1);
    }
    if (input === "+" || input === "-") {
      onNarrativeScroll?.(input === "-" ? -1 : 1);
    }
  }, { isActive });

  const handleCustomInputSubmit = (value: string) => {
    if (!value.trim()) return;
    onSelect(value.trim());
  };

  const hasDescriptions = descriptions != null && descriptions.length > 0;
  const choiceRows = Math.max(1, maxChoiceRowsProp ?? MAX_CHOICE_ROWS);

  // Pre-wrap all choice items
  // Prefix layout: [arrow 1ch][gap 1ch][cursor 1ch][space 1ch] = 4 chars
  const prefixWidth = 4;
  const labelWidth = Math.max(1, width - prefixWidth);
  const customInputWidth = Math.max(1, width - prefixWidth);

  // Visual line count for the custom-input row.
  //   - Idle (input not active): always 1 line ("Enter your own...").
  //   - Active and empty: 1 line (cursor + placeholder).
  //   - Active with text: ceil(len / w), plus an extra empty wrap line when
  //     the value lands on a wrap boundary so the cursor has somewhere to sit.
  //   Mirrors the textLines computation inside InlineTextInput so the
  //   parent's budget matches what gets drawn. Capped at `choiceRows` so
  //   long input scrolls *inside* the InlineTextInput (via maxLines) rather
  //   than spilling past the bottom of the overlay.
  let customLineCount = 1;
  if (customInputActive && customInputValue.length > 0) {
    const w = customInputWidth;
    const len = customInputValue.length;
    customLineCount = Math.ceil(len / w) + (len % w === 0 ? 1 : 0);
  }
  const customLineCap = Math.max(1, choiceRows);
  customLineCount = Math.min(customLineCount, customLineCap);

  interface WrappedItem { index: number; isCustom: boolean; lines: FormattingNode[][] }
  const allItems: WrappedItem[] = [];
  if (showCustomInput) {
    const customLines: FormattingNode[][] = customInputActive
      ? Array.from({ length: customLineCount }, () => [] as FormattingNode[])
      : [["Enter your own..."]];
    allItems.push({
      index: 0,
      isCustom: true,
      lines: customLines,
    });
  }
  for (let i = 0; i < choices.length; i++) {
    const nodes = parseFormatting(choices[i]);
    const lines = wrapNodes(nodes, labelWidth);
    // Cap to MAX_CHOICE_ROWS (a single item can't exceed the budget)
    if (lines.length > MAX_CHOICE_ROWS) {
      lines.length = MAX_CHOICE_ROWS;
      const lastLine = lines[MAX_CHOICE_ROWS - 1];
      lines[MAX_CHOICE_ROWS - 1] = [...lastLine, "…"];
    }
    allItems.push({ index: i + 1, isCustom: false, lines });
  }

  // Find visible window: fit items within choiceRows visual rows,
  // ensuring selectedIndex is visible.
  const getVisibleEnd = (start: number): number => {
    let rows = 0;
    let end = start;
    while (end < allItems.length) {
      const itemRows = allItems[end].lines.length;
      if (rows + itemRows > choiceRows && end > start) break;
      rows += itemRows;
      end++;
    }
    return end;
  };

  // Adjust scrollStart only when selectedIndex falls outside the visible window.
  // This keeps the viewport stable — pressing UP moves the cursor up through
  // visible items before scrolling, and vice versa for DOWN.
  // Uses a ref (not state) since scrollStart is a display detail derived from
  // selectedIndex — no extra re-render needed; the current render already uses
  // the adjusted value.
  let adjustedStart = scrollStartRef.current;
  // Clamp to valid range (choices may have changed)
  if (adjustedStart >= allItems.length) adjustedStart = Math.max(0, allItems.length - 1);
  // If selected item is before the window, scroll up to it
  if (selectedIndex < adjustedStart) {
    adjustedStart = selectedIndex;
  }
  // If selected item is at or past the window end, push forward
  while (adjustedStart < allItems.length && getVisibleEnd(adjustedStart) <= selectedIndex) {
    adjustedStart++;
  }
  scrollStartRef.current = adjustedStart;

  const scrollEnd = getVisibleEnd(adjustedStart);
  const canScrollUp = adjustedStart > 0;
  const canScrollDown = scrollEnd < allItems.length;

  const visibleItems = allItems.slice(adjustedStart, scrollEnd);

  // Flatten visible items into visual rows for arrow placement
  interface VisualRow {
    itemIndex: number;
    isCustom: boolean;
    isItemFirstLine: boolean;
    nodes: FormattingNode[];
  }
  const visualRows: VisualRow[] = [];
  for (const item of visibleItems) {
    for (let lineIdx = 0; lineIdx < item.lines.length; lineIdx++) {
      visualRows.push({
        itemIndex: item.index,
        isCustom: item.isCustom,
        isItemFirstLine: lineIdx === 0,
        nodes: item.lines[lineIdx],
      });
    }
  }

  // Truncate prompt to available width
  const displayPrompt =
    prompt.length > width
      ? prompt.slice(0, width - 1) + "…"
      : prompt;

  // Description for highlighted choice (word-wrapped to fixed rows).
  // selectedIndex 0 = "Enter your own" (no description); 1..N = choices[i-1].
  const descText = hasDescriptions && selectedIndex > 0 && (selectedIndex - 1) < (descriptions?.length ?? 0)
    ? (descriptions ?? [])[selectedIndex - 1] ?? ""
    : "";
  const descLines: FormattingNode[][] = hasDescriptions ? wrapToFixedRows(descText, width, DESCRIPTION_ROWS) : [];

  // Help text
  const helpText = customInputActive
    ? "↵ submit  ESC back"
    : "↵ select";

  return (
    <Box flexDirection="column" flexGrow={1} width={width}>
      {/* Row 0: prompt text */}
      <Box>
        <Text>{displayPrompt}</Text>
      </Box>

      {/* Description region (fixed height, only when descriptions provided) */}
      {hasDescriptions && (
        <Box flexDirection="column" height={DESCRIPTION_ROWS}>
          {descLines.map((line, i) => (
            <Box key={`desc-${i}`}>
              <Text dimColor>{line.length > 0 ? renderNodes(line) : ""}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Choice rows — arrow column (col 0) + cursor column (col 1) */}
      {visualRows.map((row, rowIdx) => {
        // The active custom input renders all its visual lines from a single
        // InlineTextInput placed on the first row. Drop the placeholder rows
        // for lines 1..N-1 so they don't double-count vertically.
        if (row.isCustom && customInputActive && !row.isItemFirstLine) {
          return null;
        }

        const isSelected = row.itemIndex === selectedIndex;

        // Arrow column: ▲ on row 0, ▼ on row 1 — bright when scrollable, dimmed otherwise
        let arrowChar = " ";
        let arrowColor: string | undefined;
        let arrowDim = false;
        if (rowIdx === 0) {
          arrowChar = "▲";
          if (canScrollUp) { arrowColor = "#aaff00"; } else { arrowDim = true; }
        } else if (rowIdx === 1) {
          arrowChar = "▼";
          if (canScrollDown) { arrowColor = "#aaff00"; } else { arrowDim = true; }
        }

        // Cursor column: > on first line of selected item
        const showCursor = row.isItemFirstLine && isSelected;
        const cursorStr = showCursor ? ">" : " ";

        const arrowElement = arrowColor
          ? <Text color={arrowColor}>{arrowChar}</Text>
          : <Text dimColor={arrowDim}>{arrowChar}</Text>;

        const cursorElement = showCursor && accentColor
          ? <Text color={accentColor}>{" " + cursorStr + " "}</Text>
          : <Text>{" " + cursorStr + " "}</Text>;

        // Special rendering for active custom input — wraps to multiple lines.
        // The arrow and cursor columns are rendered as their own N-tall
        // columns so they line up row-by-row with the InlineTextInput's
        // wrapped lines (in particular, ▼ stays visible on the second visual
        // line when the input has wrapped).
        if (row.isCustom && customInputActive && row.isItemFirstLine) {
          const arrowColumn = Array.from({ length: customLineCount }, (_, i) => {
            if (i === 0) {
              return canScrollUp
                ? <Text key={i} color="#aaff00">▲</Text>
                : <Text key={i} dimColor>▲</Text>;
            }
            if (i === 1) {
              return canScrollDown
                ? <Text key={i} color="#aaff00">▼</Text>
                : <Text key={i} dimColor>▼</Text>;
            }
            return <Text key={i}> </Text>;
          });
          const cursorColumn = Array.from({ length: customLineCount }, (_, i) => {
            if (i === 0) {
              return accentColor
                ? <Text key={i} color={accentColor}>{" > "}</Text>
                : <Text key={i}>{" > "}</Text>;
            }
            return <Text key={i}>{"   "}</Text>;
          });
          return (
            <Box key="custom-active">
              <Box flexDirection="column">{arrowColumn}</Box>
              <Box flexDirection="column">{cursorColumn}</Box>
              <InlineTextInput
                key={customInputResetKey}
                isDisabled={!isActive}
                availableWidth={customInputWidth}
                wrap
                maxLines={customLineCap}
                placeholder="Enter your own..."
                onChange={setCustomInputValue}
                onSubmit={handleCustomInputSubmit}
              />
            </Box>
          );
        }

        return (
          <Box key={`${row.itemIndex}-${rowIdx}`}>
            {arrowElement}{cursorElement}
            <Text>{renderNodes(row.nodes)}</Text>
          </Box>
        );
      })}

      {/* Growth space: pushes help to the bottom while choices stay top-anchored,
        * so wrapped choices expand downward (not upward) into the empty area. */}
      <Box flexGrow={1} />

      {/* Bottom row: right-aligned help */}
      <Box justifyContent="flex-end">
        <Text dimColor>{helpText}</Text>
      </Box>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────
 * ChoiceModal — original framed version (kept for compatibility).
 * NOT used in production — only in tests. Does NOT support
 * formatting tags in choice labels (uses renderContentLine).
 * ────────────────────────────────────────────────────────── */

interface ChoiceModalProps {
  variant: FrameStyleVariant;
  width: number;
  prompt: string;
  choices: string[];
  selectedIndex: number;
  showCustomInput?: boolean;
  customInputActive?: boolean;
  customInputResetKey?: number;
  onCustomInputSubmit?: (value: string) => void;
}

/**
 * Player choice modal. Shows prompt + selectable options with arrow cursor.
 * When showCustomInput is true, adds an "Enter your own" row with an
 * embedded InlineTextInput that activates when selected.
 */
export function ChoiceModal({
  variant,
  width,
  prompt,
  choices: rawChoices,
  selectedIndex,
  showCustomInput,
  customInputActive,
  customInputResetKey,
  onCustomInputSubmit,
}: ChoiceModalProps) {
  // Defensive: ensure choices is always a string array (LLM may send unexpected shapes)
  const choices = Array.isArray(rawChoices)
    ? rawChoices.map((c) => typeof c === "string" ? c : String(c))
    : [];

  const top = renderHorizontalFrame(variant, width, "top", "Choose");
  const bottom = renderHorizontalFrame(variant, width, "bottom");
  const promptLine = renderContentLine(variant, prompt, width);
  const blankLine = renderContentLine(variant, "", width);

  const customSelected = showCustomInput && selectedIndex === choices.length;

  const helpText = customInputActive
    ? "Type your action, Enter to submit, Up/ESC to go back."
    : "Arrow keys to select, Enter to confirm, ESC to dismiss.";
  const helpLine = renderContentLine(variant, helpText, width);

  // Inner width available for the custom input row content (between border+space pairs)
  const innerWidth = width - 4; // 2 for borders + 2 for padding spaces
  const customPrefix = customInputActive ? "> Enter your own: " : "  Enter your own: ";
  const prefixLen = customPrefix.length;
  const inputWidth = Math.max(1, innerWidth - prefixLen);

  return (
    <Box flexDirection="column">
      <Box><Text color={variant.color}>{top}</Text></Box>
      <Box><Text color={variant.color}>{promptLine}</Text></Box>
      <Box><Text color={variant.color}>{blankLine}</Text></Box>
      {choices.map((c, i) => (
        <Box key={i}>
          <Text color={variant.color}>
            {renderContentLine(variant, `${i === selectedIndex ? ">" : " "} ${c}`, width)}
          </Text>
        </Box>
      ))}
      {showCustomInput && (
        customInputActive ? (
          <Box>
            <Text color={variant.color}>{`${variant.vertical} `}</Text>
            <Text>{customPrefix}</Text>
            <Box width={inputWidth}>
              <InlineTextInput
                key={customInputResetKey}
                isDisabled={false}
                availableWidth={inputWidth}
                onSubmit={onCustomInputSubmit}
              />
            </Box>
            <Text color={variant.color}>{` ${variant.vertical}`}</Text>
          </Box>
        ) : (
          <Box>
            <Text color={variant.color}>
              {renderContentLine(
                variant,
                `${customSelected ? ">" : " "} Enter your own...`,
                width,
              )}
            </Text>
          </Box>
        )
      )}
      <Box><Text color={variant.color}>{blankLine}</Text></Box>
      <Box><Text color={variant.color}>{helpLine}</Text></Box>
      <Box><Text color={variant.color}>{bottom}</Text></Box>
    </Box>
  );
}
