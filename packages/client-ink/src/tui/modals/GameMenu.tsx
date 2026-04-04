import React, { useState, useMemo } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";

interface GameMenuProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  oocActive?: boolean;
  devModeEnabled?: boolean;
  devActive?: boolean;
  tokenSummary?: string;
  onSelect: (item: string) => void;
  onDismiss: () => void;
}

const BASE_MENU_ITEMS = [
  "Resume",
  "Character Sheet",
  "Compendium",
  "Player Notes",
  "Save Transcript",
  "OOC Mode",
  "Settings",
  "Save & Exit",
  "End Session",
];

/**
 * Build the effective menu items list, conditionally including Dev Mode.
 */
export function getMenuItems(devModeEnabled?: boolean): string[] {
  if (!devModeEnabled) return BASE_MENU_ITEMS;
  const items = [...BASE_MENU_ITEMS];
  const oocIndex = items.indexOf("OOC Mode");
  items.splice(oocIndex + 1, 0, "Dev Mode");
  return items;
}

/**
 * ESC menu modal. Owns its own navigation input.
 */
export function GameMenu({
  theme,
  width,
  height,
  oocActive,
  devModeEnabled,
  devActive,
  tokenSummary,
  onSelect,
  onDismiss,
}: GameMenuProps) {
  const items = useMemo(() => getMenuItems(devModeEnabled), [devModeEnabled]);
  const [menuIndex, setMenuIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) { onDismiss(); return; }
    if (key.upArrow) { setMenuIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setMenuIndex((i) => Math.min(items.length - 1, i + 1)); return; }
    if (key.return) { onSelect(items[menuIndex]); return; }
  });

  const lines = items.map((item, i) => {
    const marker = i === menuIndex ? "◆" : "○";
    let label = item;
    if (item === "OOC Mode" && oocActive) label = "Exit OOC Mode";
    if (item === "Dev Mode" && devActive) label = "Exit Dev Mode";
    return `  ${marker} ${label}`;
  });

  return <CenteredModal theme={theme} width={width} height={height} title="Menu" footer={tokenSummary} lines={lines} />;
}
