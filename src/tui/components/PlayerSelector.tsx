import React from "react";
import { Text, Box } from "ink";

export interface PlayerEntry {
  name: string;
  isAI: boolean;
}

interface PlayerSelectorProps {
  players: PlayerEntry[];
  activeIndex: number;
}

/**
 * Bottom bar showing all players. Active player is highlighted.
 * AI players marked with (AI).
 */
export function PlayerSelector({
  players,
  activeIndex,
}: PlayerSelectorProps) {
  if (players.length <= 1) return null;

  return (
    <Box>
      {players.map((player, i) => {
        const isActive = i === activeIndex;
        const label = player.isAI ? `${player.name}(AI)` : player.name;

        return (
          <Text key={player.name}>
            {i > 0 ? "  " : ""}
            {isActive ? (
              <Text bold inverse>{` ${label} `}</Text>
            ) : (
              <Text dimColor>{label}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
