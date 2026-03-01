import React from "react";
import { Box, Text } from "ink";
import { MIN_COLUMNS, MIN_ROWS } from "../responsive.js";

interface TerminalTooSmallProps {
  columns: number;
  rows: number;
}

export function TerminalTooSmall({ columns, rows }: TerminalTooSmallProps) {
  return (
    <Box
      width={columns}
      height={rows}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <Text bold>Terminal Too Small</Text>
      <Text> </Text>
      <Text>Current size: {columns} x {rows}</Text>
      <Text>Minimum required: {MIN_COLUMNS} x {MIN_ROWS}</Text>
      <Text> </Text>
      <Text dimColor>Resize your terminal to continue.</Text>
    </Box>
  );
}
