import React from "react";
import { Box, Text } from "ink";
import type { FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderContentLine } from "../frames/index.js";
import { InlineTextInput } from "../components/InlineTextInput.js";

/* ──────────────────────────────────────────────────────────
 * ChoiceOverlay — frameless version that fills the Player Pane interior.
 * No borders; fits inside the 7-row Player Pane content area.
 * ────────────────────────────────────────────────────────── */

interface ChoiceOverlayProps {
  /** Inner width (cols - 2, between Player Pane side edges) */
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
 * Frameless choice list for embedding inside the Player Pane.
 *
 * 7-row layout:
 *   Row 0: prompt text + ▲▼ scroll arrows
 *   Rows 1-5: choices (scrolled if >5 items)
 *   Row 6: right-aligned help hint
 */
export function ChoiceOverlay({
  width,
  prompt,
  choices: rawChoices,
  selectedIndex,
  showCustomInput,
  customInputActive,
  customInputResetKey,
  onCustomInputSubmit,
}: ChoiceOverlayProps) {
  const choices = Array.isArray(rawChoices)
    ? rawChoices.map((c) => (typeof c === "string" ? c : String(c)))
    : [];

  const totalItems = choices.length + (showCustomInput ? 1 : 0);
  const maxVisible = 5;
  const needsScroll = totalItems > maxVisible;

  // Keep selectedIndex in the visible window
  let scrollStart = 0;
  if (needsScroll) {
    scrollStart = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(maxVisible / 2),
        totalItems - maxVisible,
      ),
    );
  }
  const scrollEnd = scrollStart + Math.min(totalItems, maxVisible);

  const canScrollUp = needsScroll && scrollStart > 0;
  const canScrollDown = needsScroll && scrollEnd < totalItems;

  // Build visible item list
  const visibleItems: { index: number; isCustom: boolean; text: string }[] = [];
  for (let i = scrollStart; i < scrollEnd; i++) {
    if (i < choices.length) {
      visibleItems.push({ index: i, isCustom: false, text: choices[i] });
    } else if (showCustomInput) {
      visibleItems.push({
        index: i,
        isCustom: true,
        text: "Enter your own...",
      });
    }
  }

  // Truncate prompt to fit alongside arrows
  const arrowWidth = 3; // " ▲▼"
  const maxPromptLen = Math.max(1, width - arrowWidth);
  const displayPrompt =
    prompt.length > maxPromptLen
      ? prompt.slice(0, maxPromptLen - 1) + "…"
      : prompt;

  // Help text
  const helpText = customInputActive
    ? "↵ submit  ESC back"
    : "ESC dismiss";

  const customInputWidth = Math.max(1, width - 2); // "> " prefix

  return (
    <Box flexDirection="column" height={7} width={width}>
      {/* Row 0: prompt + scroll arrows */}
      <Box>
        <Box flexGrow={1}>
          <Text>{displayPrompt}</Text>
        </Box>
        <Text color={canScrollUp ? "#aaff00" : undefined} dimColor={!canScrollUp}>▲</Text>
        <Text color={canScrollDown ? "#aaff00" : undefined} dimColor={!canScrollDown}>▼</Text>
      </Box>

      {/* Choice rows */}
      {visibleItems.map((item) => {
        const isSelected = item.index === selectedIndex;
        if (item.isCustom && customInputActive) {
          return (
            <Box key="custom-active">
              <Text>{"> "}</Text>
              <InlineTextInput
                key={customInputResetKey}
                isDisabled={false}
                availableWidth={customInputWidth}
                onSubmit={onCustomInputSubmit}
              />
            </Box>
          );
        }
        return (
          <Box key={item.index}>
            <Text>
              {isSelected ? "> " : "  "}
              {item.text}
            </Text>
          </Box>
        );
      })}

      {/* Spacer to push help text to bottom */}
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
