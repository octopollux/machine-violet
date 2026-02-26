import React from "react";
import { Box, Text } from "ink";
import type { FrameStyleVariant } from "../../types/tui.js";
import { renderHorizontalFrame, renderContentLine } from "../frames/index.js";
import { InlineTextInput } from "../components/InlineTextInput.js";

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
