import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { CenteredModal } from "./CenteredModal.js";

interface GameMenuProps {
  variant: FrameStyleVariant;
  width: number;
  height: number;
  selectedIndex: number;
  oocActive?: boolean;
}

const MENU_ITEMS = [
  "Resume",
  "Character Sheet",
  "OOC Mode",
  "Settings",
  "Save & Quit",
];

/**
 * ESC menu modal. Standard navigation options.
 */
export function GameMenu({
  variant,
  width,
  height,
  selectedIndex,
  oocActive,
}: GameMenuProps) {
  const lines = MENU_ITEMS.map((item, i) => {
    const marker = i === selectedIndex ? "◆" : "○";
    const label = item === "OOC Mode" && oocActive ? "Exit OOC Mode" : item;
    return `  ${marker} ${label}`;
  });

  return <CenteredModal variant={variant} width={width} height={height} title="Menu" children={lines} />;
}

export { MENU_ITEMS };
