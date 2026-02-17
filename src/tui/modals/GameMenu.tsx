import React from "react";
import type { FrameStyleVariant } from "../../types/tui.js";
import { Modal } from "./Modal.js";

interface GameMenuProps {
  variant: FrameStyleVariant;
  width: number;
  selectedIndex: number;
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
  selectedIndex,
}: GameMenuProps) {
  const lines = MENU_ITEMS.map((item, i) => {
    const marker = i === selectedIndex ? "◆" : "○";
    return `  ${marker} ${item}`;
  });

  return <Modal variant={variant} width={width} children={lines} />;
}

export { MENU_ITEMS };
