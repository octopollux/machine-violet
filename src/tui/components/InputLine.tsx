import React from "react";
import { Text, Box } from "ink";

interface InputLineProps {
  characterName: string;
  value: string;
  showPlayerName?: boolean; // when player selector is dropped
  playerName?: string;
}

/**
 * Text input line with character name prefix.
 * When player selector is dropped, optionally shows player name in prompt.
 */
export function InputLine({
  characterName,
  value,
  showPlayerName,
  playerName,
}: InputLineProps) {
  const prefix = showPlayerName && playerName
    ? `${playerName}/${characterName}`
    : characterName;

  return (
    <Box>
      <Text>
        <Text bold>{prefix}</Text>
        <Text> &gt; </Text>
        <Text>{value}</Text>
        <Text dimColor>_</Text>
      </Text>
    </Box>
  );
}
