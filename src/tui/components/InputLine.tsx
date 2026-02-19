import React, { useState, useEffect } from "react";
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
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  const prefix = showPlayerName && playerName
    ? `${playerName}/${characterName}`
    : characterName;

  return (
    <Box>
      <Text>
        <Text bold>{prefix}</Text>
        <Text> &gt; </Text>
        <Text>{value}</Text>
        <Text dimColor>{cursorVisible ? "_" : " "}</Text>
      </Text>
    </Box>
  );
}
