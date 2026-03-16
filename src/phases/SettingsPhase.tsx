import React, { useState } from "react";
import { useInput, Text, Box } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame, TerminalTooSmall } from "../tui/components/index.js";
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
  const [navigated, setNavigated] = useState(false);

  // Deep-link: if initialView is set, navigate once on first render
  if (initialView === "api_keys" && !navigated) {
    setNavigated(true);
    // Schedule navigation after render to avoid setState-during-render warnings
    setTimeout(() => onApiKeys(), 0);
  }

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
  const sideWidth = theme.asset.components.edge_left.width;
  const topHeight = theme.asset.height;

  const contentWidth = cols - sideWidth * 2;
  const contentHeight = termRows - topHeight * 2;

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

  const menuHeight = menuLines.length;
  const topPad = Math.max(0, Math.floor((contentHeight - menuHeight) / 2));
  const bottomPad = Math.max(0, contentHeight - menuHeight - topPad);

  return (
    <Box flexDirection="column" width={cols} height={termRows}>
      <ThemedHorizontalBorder
        theme={theme}
        width={cols}
        position="top"
        centerText="Settings"
      />

      <Box flexDirection="row" height={contentHeight}>
        <ThemedSideFrame theme={theme} side="left" height={contentHeight} />
        <Box flexDirection="column" width={contentWidth} alignItems="center">
          {topPad > 0 && <Box height={topPad} />}

          <Box flexDirection="column" alignItems="flex-start">
            {menuLines}
          </Box>

          {bottomPad > 0 && <Box height={bottomPad} />}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={contentHeight} />
      </Box>

      <ThemedHorizontalBorder
        theme={theme}
        width={cols}
        position="bottom"
      />
    </Box>
  );
}
