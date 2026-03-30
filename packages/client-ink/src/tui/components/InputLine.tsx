import React from "react";
import { Text, Box } from "ink";
import { InlineTextInput } from "./InlineTextInput.js";

interface InputLineProps {
  characterName: string;
  showPlayerName?: boolean;
  playerName?: string;
  width?: number;
  isDisabled?: boolean;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  resetKey?: number;
}

/**
 * Text input line with character name prefix.
 * Wraps InlineTextInput for proper cursor management.
 */
export const InputLine = React.memo(function InputLine({
  characterName,
  showPlayerName,
  playerName,
  width,
  isDisabled,
  defaultValue,
  onChange,
  onSubmit,
  resetKey,
}: InputLineProps) {
  const prefix = showPlayerName && playerName
    ? `${playerName}/${characterName}`
    : characterName;

  // prefix text + " > " separator
  const prefixWidth = prefix.length + 3;
  const inputWidth = width != null ? width - prefixWidth : undefined;

  return (
    <Box height={1} width={width}>
      <Text bold>{prefix}</Text>
      <Text> &gt; </Text>
      <InlineTextInput
        key={resetKey}
        isDisabled={isDisabled}
        defaultValue={defaultValue}
        availableWidth={inputWidth}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    </Box>
  );
});
