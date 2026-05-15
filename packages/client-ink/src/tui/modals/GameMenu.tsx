import React, { useState, useMemo } from "react";
import { useInput } from "ink";
import type { UsageStatus } from "@machine-violet/shared";
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
  usageStatus?: UsageStatus | null;
  onSelect: (item: string) => void;
  onDismiss: () => void;
}

/**
 * Build the footer string: token tier stats, then (only when the active
 * provider exposes a primary `percentage` usage segment) a separator and
 * the `<remaining>%` figure. We invert the provider's `usedPercent` so
 * the displayed value matches the gem-gauge semantics (how much
 * headroom is left, not how much has been spent). Width grows with the
 * number — no padding — and `minWidth` on CenteredModal is bumped to fit.
 */
function buildFooter(tokenSummary: string | undefined, usage: UsageStatus | null | undefined): string | undefined {
  if (!tokenSummary) return tokenSummary;
  const primary = usage?.segments.find((s) => s.id === "primary");
  if (!primary || primary.kind !== "percentage" || primary.usedPercent === undefined) {
    return tokenSummary;
  }
  const remaining = Math.max(0, Math.min(100, Math.round(100 - primary.usedPercent)));
  return `${tokenSummary} | ${remaining}%`;
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
  usageStatus,
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

  // Bump minWidth from the default 40 to 48 so the appended `<n>%` (up
  // to four chars after a ` | ` separator) doesn't get clipped at the
  // border. Harmless when usageStatus is absent — the modal just has a
  // little extra horizontal breathing room.
  const footer = buildFooter(tokenSummary, usageStatus);
  return <CenteredModal theme={theme} width={width} height={height} title="Menu" footer={footer} lines={lines} minWidth={48} />;
}
