import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { CenteredModal } from "./CenteredModal.js";

interface GameMenuProps {
  variant: FrameStyleVariant;
  width: number;
  height: number;
  selectedIndex: number;
  oocActive?: boolean;
  devModeEnabled?: boolean;
  devActive?: boolean;
  tokenSummary?: string;
}

const BASE_MENU_ITEMS = [
  "Resume",
  "Character Sheet",
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
 * ESC menu modal. Standard navigation options.
 */
export function GameMenu({
  variant,
  width,
  height,
  selectedIndex,
  oocActive,
  devModeEnabled,
  devActive,
  tokenSummary,
}: GameMenuProps) {
  const items = getMenuItems(devModeEnabled);
  const lines = items.map((item, i) => {
    const marker = i === selectedIndex ? "◆" : "○";
    let label = item;
    if (item === "OOC Mode" && oocActive) label = "Exit OOC Mode";
    if (item === "Dev Mode" && devActive) label = "Exit Dev Mode";
    return `  ${marker} ${label}`;
  });

  return <CenteredModal variant={variant} width={width} height={height} title="Menu" footer={tokenSummary} children={lines} />;
}

