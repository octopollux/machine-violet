/**
 * KeyHints — small indicator of available hotkeys.
 *
 * Rendered in the top-right of the Player Pane. Each hint is a single
 * character or short label that lights up when its feature is active.
 */
import React from "react";
import { Text } from "ink";

export interface KeyHint {
  /** Display label (e.g. "Tab") */
  label: string;
  /** Whether the associated feature is currently active. */
  active: boolean;
}

interface KeyHintsProps {
  hints: KeyHint[];
}

/**
 * Renders key hints inline. Inactive hints are dim gray;
 * active hints are yellow.
 */
export const KeyHints = React.memo(function KeyHints({ hints }: KeyHintsProps) {
  return (
    <Text>
      {hints.map((hint, i) => (
        <Text key={i} color={hint.active ? "yellow" : "gray"} dimColor={!hint.active}>
          {i > 0 ? " " : ""}{hint.label}
        </Text>
      ))}
    </Text>
  );
});
