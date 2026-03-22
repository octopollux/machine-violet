import React, { useState, useEffect, useRef } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { themeColor } from "../tui/themes/color-resolve.js";

export interface SettingsPhaseProps {
  theme: ResolvedTheme;
  /** When set, the phase immediately navigates to a sub-screen on mount. */
  initialView?: "api_keys";
  onApiKeys: () => void;
  onBack: () => void;
}

const MENU_ITEMS = ["API Keys"];

export function SettingsPhase({
  theme,
  initialView,
  onApiKeys,
  onBack,
}: SettingsPhaseProps) {
  const { columns: cols, rows: termRows } = useTerminalSize();
  const [menuIndex, setMenuIndex] = useState(0);
  const navigatedRef = useRef(false);

  // Deep-link: if initialView is set, navigate once on mount
  useEffect(() => {
    if (initialView === "api_keys" && !navigatedRef.current) {
      navigatedRef.current = true;
      onApiKeys();
    }
  }, [initialView, onApiKeys]);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setMenuIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setMenuIndex((i) => Math.min(MENU_ITEMS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const selected = MENU_ITEMS[menuIndex];
      if (selected === "API Keys") {
        onApiKeys();
      }
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";

  const menuLines: React.ReactNode[] = [];
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const item = MENU_ITEMS[i];
    const isSelected = i === menuIndex;
    const marker = isSelected ? "◆" : "○";
    const markerColor = isSelected ? borderColor : dimColor;

    menuLines.push(
      <Text key={item}>
        <Text color={markerColor}>{marker}</Text>
        <Text>{` ${item}`}</Text>
      </Text>,
    );
  }

  return (
    <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="Settings" contentRows={menuLines.length}>
      {menuLines}
    </FullScreenFrame>
  );
}
