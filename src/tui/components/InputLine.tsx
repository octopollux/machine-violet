import React from "react";
import { Text, Box } from "ink";
import { InlineTextInput } from "./InlineTextInput.js";

interface InputLineProps {
  characterName: string;
  showPlayerName?: boolean;
  playerName?: string;
  isDisabled?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  resetKey?: number;
}

/**
 * Text input line with character name prefix.
 * Wraps InlineTextInput for proper cursor management.
 */
export function InputLine({
  characterName,
  showPlayerName,
  playerName,
  isDisabled,
  onChange,
  onSubmit,
  resetKey,
}: InputLineProps) {
  const prefix = showPlayerName && playerName
    ? `${playerName}/${characterName}`
    : characterName;

  return (
    <Box>
      <Text bold>{prefix}</Text>
      <Text> &gt; </Text>
      <InlineTextInput
        key={resetKey}
        isDisabled={isDisabled}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
